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

  // Build the frontend journey object from DB rows
  function buildJourney(journeyRow, segmentRows, photoRows, gpxRows) {
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
          .map(p => ({ url: p.url, lat: Number(p.lat) || 0, lng: Number(p.lng) || 0 }));

        const gpxPoints = (gpxBySegment[seg.id] || [])
          .sort((a, b) => a.point_index - b.point_index)
          .map(pt => [Number(pt.lat), Number(pt.lng), pt.elevation != null ? Number(pt.elevation) : null])
          .filter(p => !isNaN(p[0]) && !isNaN(p[1]));

        if (gpxPoints.length > 0) {
          console.log('[buildJourney] segment', seg.id, 'day', seg.day_index, 'gpxPoints count:', gpxPoints.length, 'first:', gpxPoints[0], 'last:', gpxPoints[gpxPoints.length - 1]);
        }

        return {
          day: seg.day_index,
          date: formatDate(seg.date),
          note: seg.note || '',
          photoCount: photos.length,
          photos,
          photoUrls: photos.map(p => p.url),
          gpx: gpxPoints.length > 0,
          gpxPoints,
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
      coverUrl: journeyRow.cover_url || coverUrlFromSegments(segments)
    };
  }

  async function fetchJourneyWithData(journeyId) {
    const { data: journeyRow, error: jErr } = await supabaseClient
      .from('journeys')
      .select('*')
      .eq('id', journeyId)
      .maybeSingle();
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
      const { data: pRows, error: pErr } = await supabaseClient
        .from('photos')
        .select('*')
        .in('segment_id', segmentIds);
      if (pErr) throw pErr;
      photoRows = pRows || [];

      const { data: gRows, error: gErr } = await supabaseClient
        .from('gpx_points')
        .select('*')
        .in('segment_id', segmentIds);
      if (gErr) throw gErr;
      gpxRows = gRows || [];
    }

    return buildJourney(journeyRow, segmentRows || [], photoRows, gpxRows);
  }

  async function updateJourneyTotals(journeyId) {
    const journey = await fetchJourneyWithData(journeyId);
    const totalDist = journey.segments.reduce((s, seg) => s + (seg.distance || 0), 0);
    const totalElev = journey.segments.reduce((s, seg) => s + (seg.elevation || 0), 0);
    const coverUrl = coverUrlFromSegments(journey.segments);

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

      const results = await Promise.all((journeyRows || []).map(j => fetchJourneyWithData(j.id)));
      return results.filter(Boolean);
    }

    if (publicOnly) return [];
    return getLocalJourneys(status);
  }

  async function getJourney(id) {
    if (await isLoggedIn()) {
      return fetchJourneyWithData(id);
    }
    return getLocalJourney(id);
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
    return updateJourney(journey);
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
      .select('id')
      .eq('id', journeyId)
      .eq('user_id', userId)
      .maybeSingle();
    if (jErr) throw jErr;
    if (!journeyRow) throw new Error('旅程不存在或无权限');

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

      const { error: updErr } = await supabaseClient
        .from('segments')
        .update({
          date: segment.date,
          note: segment.note,
          distance: segment.distance || 0,
          elevation: segment.elevation || 0,
          elevation_loss: segment.elevationLoss || 0,
          duration: segment.duration || '-'
        })
        .eq('id', segmentId);
      if (updErr) throw updErr;

      await supabaseClient.from('photos').delete().eq('segment_id', segmentId);
      await supabaseClient.from('gpx_points').delete().eq('segment_id', segmentId);
    } else {
      const { data: newSeg, error: insErr } = await supabaseClient
        .from('segments')
        .insert({
          journey_id: journeyId,
          day_index: segment.day,
          date: segment.date,
          note: segment.note,
          distance: segment.distance || 0,
          elevation: segment.elevation || 0,
          elevation_loss: segment.elevationLoss || 0,
          duration: segment.duration || '-'
        })
        .select()
        .single();
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
      const gpxRows = segment.gpxPoints.map((pt, i) => ({
        segment_id: segmentId,
        lat: pt[0],
        lng: pt[1],
        elevation: pt[2] != null ? pt[2] : null,
        point_index: i
      }));
      const { error: gErr } = await supabaseClient.from('gpx_points').insert(gpxRows);
      if (gErr) throw gErr;
    }

    await updateJourneyTotals(journeyId);
    return fetchJourneyWithData(journeyId);
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
    createJourney,
    updateJourney,
    deleteJourney,
    deleteSegment,
    endJourney,
    saveSegment,
    migrateLocalStorage
  };
})();
