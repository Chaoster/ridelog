// Journey data service
// Adapts the frontend journey/segment shape to the normalized Supabase schema:
// journeys -> segments -> photos / gpx_points

(function () {
  const LOCAL_ONGOING_KEY = 'ongoingJourneys';
  const LOCAL_COMPLETED_KEY = 'completedJourneys';
  const MIGRATION_KEY = 'ridelogMigrated';

  async function ensureUser() {
    if (window.currentUser) return window.currentUser;
    const { data, error } = await supabaseClient.auth.getUser();
    if (error || !data.user) return null;
    window.currentUser = data.user;
    return data.user;
  }

  async function isLoggedIn() {
    const user = await ensureUser();
    return !!user;
  }

  async function getUserId() {
    const user = await ensureUser();
    return user?.id;
  }

  // ----- Helpers -----

  function formatDate(ts) {
    if (!ts) return null;
    return ts.slice(0, 10);
  }

  function coverUrlFromSegments(segments) {
    for (const seg of segments || []) {
      if (seg.photos?.length) return seg.photos[0].url;
    }
    return null;
  }

  function routeSvgFromSegments(segments) {
    for (const seg of segments || []) {
      if (seg.routeSvg) return seg.routeSvg;
    }
    return null;
  }

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = deg => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function simplifyGpxPoints(points, thresholdMeters = 30) {
    if (!points || points.length <= 2) return points;
    const result = [points[0]];
    let last = points[0];
    for (let i = 1; i < points.length - 1; i++) {
      const p = points[i];
      const dist = haversineMeters(last[0], last[1], p[0], p[1]);
      if (dist >= thresholdMeters) {
        result.push(p);
        last = p;
      }
    }
    result.push(points[points.length - 1]);
    return result;
  }

  // Build the frontend journey object from DB rows
  function buildJourney(journeyRow, segmentRows, photoRows, gpxRows, editIdx = -1, photoLimit = null) {
    const photosBySegment = {};
    photoRows.forEach(p => {
      photosBySegment[p.segment_id] = photosBySegment[p.segment_id] || [];
      photosBySegment[p.segment_id].push(p);
    });

    const gpxBySegment = {};
    gpxRows.forEach(pt => {
      gpxBySegment[pt.segment_id] = gpxBySegment[pt.segment_id] || [];
      gpxBySegment[pt.segment_id].push(pt);
    });

    const segments = (segmentRows || [])
      .sort((a, b) => a.day_index - b.day_index)
      .map(seg => {
        const photos = (photosBySegment[seg.id] || [])
          .sort((a, b) => a.created_at - b.created_at)
          .slice(0, photoLimit || Infinity)
          .map(p => ({ url: p.url, lat: Number(p.lat) || 0, lng: Number(p.lng) || 0 }));

        const rawGpxRows = (gpxBySegment[seg.id] || []).sort((a, b) => a.point_index - b.point_index);
        const gpxPoints = rawGpxRows
          .map(pt => [Number(pt.lat), Number(pt.lng), pt.elevation != null ? Number(pt.elevation) : null])
          .filter(p => !isNaN(p[0]) && !isNaN(p[1]));

        const shouldSimplify = editIdx < 0;
        const simplifiedGpx = shouldSimplify ? simplifyGpxPoints(gpxPoints, 30) : gpxPoints;

        if (gpxPoints.length > 0) {
          console.log('[buildJourney] segment', seg.id, 'day', seg.day_index, 'raw rows:', rawGpxRows.length, 'valid points:', gpxPoints.length, 'simplified:', simplifiedGpx.length, 'first 3 raw:', rawGpxRows.slice(0, 3), 'last raw:', rawGpxRows[rawGpxRows.length - 1]);
        }

        return {
          day: seg.day_index,
          date: formatDate(seg.date),
          note: seg.note || '',
          photoCount: photos.length,
          photos,
          photoUrls: photos.map(p => p.url),
          gpx: simplifiedGpx.length > 0,
          gpxPoints: simplifiedGpx,
          routeSvg: seg.route_svg || '',
          distance: Number(seg.distance) || 0,
          elevation: Number(seg.elevation) || 0,
          elevationLoss: Number(seg.elevation_loss) || 0,
          duration: seg.duration || '-'
        };
      });

    return {
      id: journeyRow.id,
      title: journeyRow.title,
      status: journeyRow.status,
      createdAt: formatDate(journeyRow.created_at),
      completedAt: formatDate(journeyRow.completed_at),
      isPublic: journeyRow.is_public,
      segments,
      coverUrl: journeyRow.cover_url || coverUrlFromSegments(segments),
      coverSvg: routeSvgFromSegments(segments)
    };
  }

  async function fetchRowsForSegment(table, segmentId, orderColumn) {
    const allRows = [];
    const batchSize = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supabaseClient
        .from(table)
        .select('*')
        .eq('segment_id', segmentId)
        .order(orderColumn, { ascending: true })
        .range(from, from + batchSize - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      allRows.push(...data);
      if (data.length < batchSize) break;
      from += batchSize;
    }
    return allRows;
  }

  async function fetchJourneyWithData(journeyId, { includePhotos = false, includeGpx = false, editIdx = -1, photoLimit = null } = {}) {
    try {
      const loggedIn = await isLoggedIn();
      const userId = loggedIn ? await getUserId() : null;

      let query = supabaseClient.from('journeys').select('*').eq('id', journeyId);
      if (loggedIn) {
        query = query.eq('user_id', userId);
      }
      const { data: journeyRow, error: jErr } = await query.maybeSingle();
      if (jErr) throw jErr;
      if (!journeyRow) return null;

      const { data: segmentRows, error: sErr } = await supabaseClient
        .from('segments')
        .select('*')
        .eq('journey_id', journeyId);
      if (sErr) throw sErr;

      const segmentIds = (segmentRows || []).map(s => s.id);
      let photoRows = [];
      let gpxRows = [];

      if (segmentIds.length) {
        // For edit mode, only load full gpx/photos for the target segment
        const targetIds = editIdx >= 0 && segmentRows[editIdx]
          ? [segmentRows[editIdx].id]
          : segmentIds;

        if (includePhotos) {
          if (photoLimit != null && photoLimit > 0 && editIdx < 0 && targetIds.length > 0) {
            // 列表场景：一次性批量查询所有 segment 的照片，在 buildJourney 中按 segment 限制数量
            const { data, error } = await supabaseClient
              .from('photos')
              .select('*')
              .in('segment_id', targetIds)
              .order('created_at', { ascending: true });
            if (error) {
              console.error('[fetchJourneyWithData] photos batch fetch error:', error);
            } else {
              photoRows = data || [];
            }
          } else {
            const photoResults = await Promise.all(targetIds.map(segId => {
              if (photoLimit != null && photoLimit > 0) {
                return supabaseClient
                  .from('photos')
                  .select('*')
                  .eq('segment_id', segId)
                  .order('created_at', { ascending: true })
                  .limit(photoLimit)
                  .then(({ data, error }) => {
                    if (error) throw error;
                    return data || [];
                  })
                  .catch(e => {
                    console.error('[fetchJourneyWithData] photos fetch error for segment', segId, e);
                    return [];
                  });
              }
              return fetchRowsForSegment('photos', segId, 'created_at').catch(e => {
                console.error('[fetchJourneyWithData] photos fetch error for segment', segId, e);
                return [];
              });
            }));
            photoRows = photoResults.flat();
          }
        }
        if (includeGpx) {
          const gpxResults = await Promise.all(targetIds.map(segId =>
            fetchRowsForSegment('gpx_points', segId, 'point_index').catch(e => {
              console.error('[fetchJourneyWithData] gpx_points fetch error for segment', segId, e);
              return [];
            })
          ));
          gpxRows = gpxResults.flat();
        }
      }

      return buildJourney(journeyRow, segmentRows || [], photoRows, gpxRows, editIdx, photoLimit);
    } catch (err) {
      console.error('[fetchJourneyWithData] fatal error:', err);
      throw err;
    }
  }

  async function updateJourneyTotals(journeyId) {
    const { data: segmentRows, error: sErr } = await supabaseClient
      .from('segments')
      .select('id, distance, elevation')
      .eq('journey_id', journeyId);
    if (sErr) throw sErr;

    const totalDist = (segmentRows || []).reduce((s, seg) => s + (Number(seg.distance) || 0), 0);
    const totalElev = (segmentRows || []).reduce((s, seg) => s + (Number(seg.elevation) || 0), 0);

    const segmentIds = (segmentRows || []).map(s => s.id);
    let coverUrl = null;
    if (segmentIds.length > 0) {
      const { data: photoRows, error: pErr } = await supabaseClient
        .from('photos')
        .select('url')
        .in('segment_id', segmentIds)
        .order('created_at', { ascending: true })
        .limit(1);
      if (pErr) {
        console.error('[updateJourneyTotals] cover photo fetch error:', pErr);
      } else {
        coverUrl = photoRows?.[0]?.url || null;
      }
    }

    const { error } = await supabaseClient
      .from('journeys')
      .update({
        total_distance: totalDist,
        total_elevation: totalElev,
        cover_url: coverUrl,
        updated_at: new Date().toISOString()
      })
      .eq('id', journeyId);

    if (error) throw error;
  }

  // ----- localStorage fallback -----

  function getLocalJourneys(status) {
    if (status === 'ongoing') return storage.get(LOCAL_ONGOING_KEY) || [];
    if (status === 'completed') return storage.get(LOCAL_COMPLETED_KEY) || [];
    return [
      ...(storage.get(LOCAL_ONGOING_KEY) || []),
      ...(storage.get(LOCAL_COMPLETED_KEY) || [])
    ];
  }

  function getLocalJourney(id) {
    const all = getLocalJourneys();
    return all.find(j => j.id === id) || null;
  }

  function saveLocalJourney(journey) {
    const ongoing = storage.get(LOCAL_ONGOING_KEY) || [];
    const completed = storage.get(LOCAL_COMPLETED_KEY) || [];

    if (journey.status === 'ongoing') {
      const idx = ongoing.findIndex(j => j.id === journey.id);
      if (idx >= 0) ongoing[idx] = journey;
      else ongoing.unshift(journey);
      storage.set(LOCAL_ONGOING_KEY, ongoing);
      storage.set(LOCAL_COMPLETED_KEY, completed.filter(j => j.id !== journey.id));
    } else {
      const idx = completed.findIndex(j => j.id === journey.id);
      if (idx >= 0) completed[idx] = journey;
      else completed.unshift(journey);
      storage.set(LOCAL_COMPLETED_KEY, completed);
      storage.set(LOCAL_ONGOING_KEY, ongoing.filter(j => j.id !== journey.id));
    }
  }

  function deleteLocalJourney(id) {
    const ongoing = storage.get(LOCAL_ONGOING_KEY) || [];
    const completed = storage.get(LOCAL_COMPLETED_KEY) || [];
    storage.set(LOCAL_ONGOING_KEY, ongoing.filter(j => j.id !== id));
    storage.set(LOCAL_COMPLETED_KEY, completed.filter(j => j.id !== id));
  }

  // ----- Supabase public API -----

  async function getJourneys({ status, publicOnly } = {}) {
    if (await isLoggedIn()) {
      let query = supabaseClient.from('journeys').select('*');

      if (publicOnly) {
        query = query.eq('is_public', true).eq('status', 'completed');
      } else {
        query = query.eq('user_id', await getUserId());
        if (status) query = query.eq('status', status);
      }

      query = query.order('created_at', { ascending: false });

      const { data: journeyRows, error } = await query;
      if (error) {
        console.error('[journeyService] getJourneys error:', error);
        throw error;
      }

      const results = await Promise.all((journeyRows || []).map(async j => {
        try {
          return await fetchJourneyWithData(j.id, { includePhotos: false, includeGpx: false });
        } catch (err) {
          console.error('[journeyService] fetch journey summary error, id:', j.id, err);
          return null;
        }
      }));
      return results.filter(Boolean);
    }

    if (publicOnly) return [];
    return getLocalJourneys(status);
  }

  async function getJourneySummary(id) {
    if (await isLoggedIn()) {
      return fetchJourneyWithData(id, { includePhotos: true, includeGpx: false, photoLimit: 7 });
    }
    return getLocalJourney(id);
  }

  async function getJourneyForEdit(id, editIdx) {
    if (await isLoggedIn()) {
      return fetchJourneyWithData(id, { includePhotos: true, includeGpx: true, editIdx });
    }
    return getLocalJourney(id);
  }

  async function getJourney(id) {
    if (await isLoggedIn()) {
      return fetchJourneyWithData(id, { includePhotos: true, includeGpx: true });
    }
    return getLocalJourney(id);
  }

  async function getJourneyMinimal(id) {
    if (await isLoggedIn()) {
      const { data, error } = await supabaseClient
        .from('journeys')
        .select('id, title, status, created_at, completed_at, is_public, total_distance, total_elevation, cover_url')
        .eq('id', id)
        .eq('user_id', await getUserId())
        .maybeSingle();
      if (error) {
        console.error('[journeyService] getJourneyMinimal error:', error);
        throw error;
      }
      if (!data) return null;
      return {
        id: data.id,
        title: data.title,
        status: data.status,
        createdAt: formatDate(data.created_at),
        completedAt: formatDate(data.completed_at),
        isPublic: data.is_public,
        segments: [],
        coverUrl: data.cover_url
      };
    }

    const local = getLocalJourney(id);
    if (local) {
      return {
        ...local,
        segments: []
      };
    }
    return null;
  }

  async function createJourney(title) {
    if (await isLoggedIn()) {
      const userId = await getUserId();
      const { data, error } = await supabaseClient
        .from('journeys')
        .insert({
          user_id: userId,
          title,
          status: 'ongoing',
          is_public: false,
          total_distance: 0,
          total_elevation: 0
        })
        .select()
        .single();

      if (error) {
        console.error('[journeyService] createJourney error:', error);
        throw error;
      }
      return buildJourney(data, [], [], []);
    }

    const journey = {
      id: 'j_' + Date.now(),
      title,
      status: 'ongoing',
      createdAt: new Date().toISOString().slice(0, 10),
      segments: []
    };
    saveLocalJourney(journey);
    return journey;
  }

  async function updateJourney(journey) {
    if (await isLoggedIn()) {
      const { error } = await supabaseClient
        .from('journeys')
        .update({
          title: journey.title,
          status: journey.status,
          is_public: journey.isPublic || false,
          completed_at: journey.completedAt || null,
          updated_at: new Date().toISOString()
        })
        .eq('id', journey.id)
        .eq('user_id', await getUserId());

      if (error) {
        console.error('[journeyService] updateJourney error:', error);
        throw error;
      }
      return fetchJourneyWithData(journey.id);
    }

    saveLocalJourney(journey);
    return journey;
  }

  async function deleteJourney(id) {
    if (await isLoggedIn()) {
      const { error } = await supabaseClient
        .from('journeys')
        .delete()
        .eq('id', id)
        .eq('user_id', await getUserId());

      if (error) {
        console.error('[journeyService] deleteJourney error:', error);
        throw error;
      }
      return;
    }

    deleteLocalJourney(id);
  }

  async function deleteSegment(journeyId, editIdx) {
    if (!(await isLoggedIn())) {
      const journey = await getJourney(journeyId);
      if (!journey) throw new Error('旅程不存在');
      if (!journey.segments) journey.segments = [];
      if (editIdx >= 0 && editIdx < journey.segments.length) {
        journey.segments.splice(editIdx, 1);
        saveLocalJourney(journey);
      }
      return journey;
    }

    const { data: existingSegs, error: findErr } = await supabaseClient
      .from('segments')
      .select('id')
      .eq('journey_id', journeyId)
      .order('day_index', { ascending: true });
    if (findErr) throw findErr;

    const target = (existingSegs || [])[editIdx];
    if (!target) throw new Error('要删除的记录不存在');

    const { error: delErr } = await supabaseClient
      .from('segments')
      .delete()
      .eq('id', target.id);
    if (delErr) throw delErr;

    await updateJourneyTotals(journeyId);
    return fetchJourneyWithData(journeyId);
  }

  async function endJourney(id) {
    const journey = await getJourney(id);
    if (!journey) throw new Error('旅程不存在');
    journey.status = 'completed';
    journey.completedAt = new Date().toISOString().slice(0, 10);
    const updated = await updateJourney(journey);
    if (!updated) {
      console.error('[journeyService] endJourney: update succeeded but fetch returned null, id:', id);
      throw new Error('结束旅程后无法读取旅程数据，请检查登录状态或刷新页面');
    }
    return updated;
  }

  async function saveSegment(journeyId, segment, editIdx) {
    if (!(await isLoggedIn())) {
      const journey = await getJourney(journeyId);
      if (!journey) throw new Error('旅程不存在');
      if (!journey.segments) journey.segments = [];
      if (editIdx >= 0 && journey.segments[editIdx]) {
        journey.segments[editIdx] = segment;
      } else {
        journey.segments.push(segment);
        journey.segments.sort((a, b) => a.day - b.day);
      }
      saveLocalJourney(journey);
      return journey;
    }

    const userId = await getUserId();

    const { data: journeyRow, error: jErr } = await supabaseClient
      .from('journeys')
      .select('id, status')
      .eq('id', journeyId)
      .eq('user_id', userId)
      .maybeSingle();
    if (jErr) throw jErr;
    if (!journeyRow) throw new Error('旅程不存在或无权限');
    const journeyStatus = journeyRow.status;

    let segmentId;
    let isUpdate = editIdx >= 0;

    if (!isUpdate) {
      // Guard against double-submit creating duplicate day records
      const { data: sameDaySeg, error: sdErr } = await supabaseClient
        .from('segments')
        .select('id')
        .eq('journey_id', journeyId)
        .eq('day_index', segment.day)
        .maybeSingle();
      if (sdErr) throw sdErr;
      if (sameDaySeg) {
        isUpdate = true;
        segmentId = sameDaySeg.id;
      }
    }

    function stripRouteSvg(err) {
      return err && err.message && err.message.toLowerCase().includes('route_svg');
    }

    if (isUpdate) {
      if (!segmentId) {
        const { data: existingSegs, error: findErr } = await supabaseClient
          .from('segments')
          .select('id, day_index')
          .eq('journey_id', journeyId)
          .order('day_index', { ascending: true });
        if (findErr) throw findErr;

        const target = (existingSegs || [])[editIdx];
        if (!target) throw new Error('要编辑的记录不存在');
        segmentId = target.id;
      }

      let updatePayload = {
        date: segment.date,
        note: segment.note,
        distance: segment.distance || 0,
        elevation: segment.elevation || 0,
        elevation_loss: segment.elevationLoss || 0,
        duration: segment.duration || '-',
        route_svg: segment.routeSvg || null
      };
      let { error: updErr } = await supabaseClient
        .from('segments')
        .update(updatePayload)
        .eq('id', segmentId);
      if (updErr && stripRouteSvg(updErr)) {
        delete updatePayload.route_svg;
        ({ error: updErr } = await supabaseClient
          .from('segments')
          .update(updatePayload)
          .eq('id', segmentId));
      }
      if (updErr) throw updErr;

      await supabaseClient.from('photos').delete().eq('segment_id', segmentId);
      await supabaseClient.from('gpx_points').delete().eq('segment_id', segmentId);
    } else {
      let insertPayload = {
        journey_id: journeyId,
        day_index: segment.day,
        date: segment.date,
        note: segment.note,
        distance: segment.distance || 0,
        elevation: segment.elevation || 0,
        elevation_loss: segment.elevationLoss || 0,
        duration: segment.duration || '-',
        route_svg: segment.routeSvg || null
      };
      let { data: newSeg, error: insErr } = await supabaseClient
        .from('segments')
        .insert(insertPayload)
        .select()
        .single();
      if (insErr && stripRouteSvg(insErr)) {
        delete insertPayload.route_svg;
        ({ data: newSeg, error: insErr } = await supabaseClient
          .from('segments')
          .insert(insertPayload)
          .select()
          .single());
      }
      if (insErr) throw insErr;
      segmentId = newSeg.id;
    }

    if (segment.photos?.length) {
      const photoRows = segment.photos.map(p => ({
        segment_id: segmentId,
        url: p.url,
        lat: p.lat || 0,
        lng: p.lng || 0
      }));
      const { error: pErr } = await supabaseClient.from('photos').insert(photoRows);
      if (pErr) throw pErr;
    }

    if (segment.gpxPoints?.length) {
      const BATCH_SIZE = 1000;
      console.log('[saveSegment] inserting', segment.gpxPoints.length, 'gpx points for segment', segmentId);
      for (let i = 0; i < segment.gpxPoints.length; i += BATCH_SIZE) {
        const batch = segment.gpxPoints.slice(i, i + BATCH_SIZE).map((pt, idx) => ({
          segment_id: segmentId,
          lat: pt[0],
          lng: pt[1],
          elevation: pt[2] != null ? pt[2] : null,
          point_index: i + idx
        }));
        console.log('[saveSegment] batch', i / BATCH_SIZE + 1, 'size:', batch.length, 'first:', batch[0]);
        const { error: gErr } = await supabaseClient.from('gpx_points').insert(batch);
        if (gErr) {
          console.error('[saveSegment] gpx_points insert error:', gErr);
          throw gErr;
        }
      }
    } else {
      console.log('[saveSegment] no gpxPoints to insert for segment', segmentId);
    }

    await updateJourneyTotals(journeyId);
    return { id: journeyId, status: journeyStatus };
  }

  async function migrateLocalStorage() {
    if (!(await isLoggedIn())) return;
    if (localStorage.getItem(MIGRATION_KEY) === '1') return;

    const ongoing = storage.get(LOCAL_ONGOING_KEY) || [];
    const completed = storage.get(LOCAL_COMPLETED_KEY) || [];
    const all = [...ongoing, ...completed];
    if (all.length === 0) {
      localStorage.setItem(MIGRATION_KEY, '1');
      return;
    }

    const userId = await getUserId();

    for (const j of all) {
      const { data: journeyRow, error: jErr } = await supabaseClient
        .from('journeys')
        .insert({
          user_id: userId,
          title: j.title,
          status: j.completedAt ? 'completed' : 'ongoing',
          is_public: false,
          completed_at: j.completedAt || null,
          total_distance: 0,
          total_elevation: 0
        })
        .select()
        .single();
      if (jErr) {
        console.error('[journeyService] migrate journey error:', jErr);
        throw jErr;
      }

      const journeyId = journeyRow.id;

      for (const seg of j.segments || []) {
        const { data: segRow, error: sErr } = await supabaseClient
          .from('segments')
          .insert({
            journey_id: journeyId,
            day_index: seg.day,
            date: seg.date,
            note: seg.note,
            distance: seg.distance || 0,
            elevation: seg.elevation || 0,
            elevation_loss: seg.elevationLoss || 0,
            duration: seg.duration || '-'
          })
          .select()
          .single();
        if (sErr) {
          console.error('[journeyService] migrate segment error:', sErr);
          throw sErr;
        }

        const segmentId = segRow.id;

        if (seg.photos?.length) {
          const { error: pErr } = await supabaseClient.from('photos').insert(
            seg.photos.map(p => ({
              segment_id: segmentId,
              url: p.url,
              lat: p.lat || 0,
              lng: p.lng || 0
            }))
          );
          if (pErr) {
            console.error('[journeyService] migrate photos error:', pErr);
            throw pErr;
          }
        }

        if (seg.gpxPoints?.length) {
          const { error: gErr } = await supabaseClient.from('gpx_points').insert(
            seg.gpxPoints.map((pt, i) => ({
              segment_id: segmentId,
              lat: pt[0],
              lng: pt[1],
              elevation: pt[2] != null ? pt[2] : null,
              point_index: i
            }))
          );
          if (gErr) {
            console.error('[journeyService] migrate gpx error:', gErr);
            throw gErr;
          }
        }
      }

      await updateJourneyTotals(journeyId);
    }

    localStorage.setItem(MIGRATION_KEY, '1');
  }

  window.journeyService = {
    isLoggedIn,
    getJourneys,
    getJourney,
    getJourneySummary,
    getJourneyMinimal,
    getJourneyForEdit,
    createJourney,
    updateJourney,
    deleteJourney,
    deleteSegment,
    endJourney,
    saveSegment,
    migrateLocalStorage
  };
})();
