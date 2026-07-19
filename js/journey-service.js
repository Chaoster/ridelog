// Journey data service
// Handles both Supabase (when logged in) and localStorage fallback (when logged out)

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

  // Convert DB row to JS journey shape
  function fromDb(row) {
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      createdAt: row.created_at ? row.created_at.slice(0, 10) : null,
      completedAt: row.completed_at ? row.completed_at.slice(0, 10) : null,
      isPublic: row.is_public,
      segments: row.segments || []
    };
  }

  // Convert JS journey to DB row
  function toDb(journey) {
    return {
      title: journey.title,
      status: journey.status,
      created_at: journey.createdAt,
      completed_at: journey.completedAt || null,
      is_public: journey.isPublic || false,
      segments: journey.segments || []
    };
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
      // remove from completed if present
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

  // ----- Supabase -----

  async function getSupabaseJourneys({ status, publicOnly } = {}) {
    if (!(await isLoggedIn())) return [];

    let query = supabaseClient.from('journeys').select('*');

    if (publicOnly) {
      query = query.eq('is_public', true).eq('status', 'completed');
    } else {
      query = query.eq('user_id', await getUserId());
      if (status) query = query.eq('status', status);
    }

    query = query.order('created_at', { ascending: false });

    const { data, error } = await query;
    if (error) {
      console.error('[journeyService] getJourneys error:', error);
      throw error;
    }
    return (data || []).map(fromDb);
  }

  async function getSupabaseJourney(id) {
    if (!(await isLoggedIn())) return null;
    const { data, error } = await supabaseClient
      .from('journeys')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      console.error('[journeyService] getJourney error:', error);
      throw error;
    }
    return fromDb(data);
  }

  async function createSupabaseJourney(title) {
    if (!(await isLoggedIn())) throw new Error('未登录');
    const now = new Date().toISOString().slice(0, 10);
    const row = {
      user_id: await getUserId(),
      title,
      status: 'ongoing',
      created_at: now,
      is_public: false,
      segments: []
    };
    const { data, error } = await supabaseClient
      .from('journeys')
      .insert(row)
      .select()
      .single();

    if (error) {
      console.error('[journeyService] createJourney error:', error);
      throw error;
    }
    return fromDb(data);
  }

  async function updateSupabaseJourney(journey) {
    if (!(await isLoggedIn())) throw new Error('未登录');
    const row = toDb(journey);
    row.updated_at = new Date().toISOString();
    const { data, error } = await supabaseClient
      .from('journeys')
      .update(row)
      .eq('id', journey.id)
      .eq('user_id', await getUserId())
      .select()
      .single();

    if (error) {
      console.error('[journeyService] updateJourney error:', error);
      throw error;
    }
    return fromDb(data);
  }

  async function deleteSupabaseJourney(id) {
    if (!(await isLoggedIn())) throw new Error('未登录');
    const { error } = await supabaseClient
      .from('journeys')
      .delete()
      .eq('id', id)
      .eq('user_id', await getUserId());

    if (error) {
      console.error('[journeyService] deleteJourney error:', error);
      throw error;
    }
  }

  // ----- Public API -----

  async function getJourneys(options = {}) {
    if (await isLoggedIn()) return getSupabaseJourneys(options);
    if (options.publicOnly) return []; // no public feed when logged out
    return getLocalJourneys(options.status);
  }

  async function getJourney(id) {
    if (await isLoggedIn()) return getSupabaseJourney(id);
    return getLocalJourney(id);
  }

  async function createJourney(title) {
    if (await isLoggedIn()) return createSupabaseJourney(title);

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
    if (await isLoggedIn()) return updateSupabaseJourney(journey);
    saveLocalJourney(journey);
    return journey;
  }

  async function deleteJourney(id) {
    if (await isLoggedIn()) return deleteSupabaseJourney(id);
    deleteLocalJourney(id);
  }

  async function endJourney(id) {
    const journey = await getJourney(id);
    if (!journey) throw new Error('旅程不存在');
    journey.status = 'completed';
    journey.completedAt = new Date().toISOString().slice(0, 10);
    return updateJourney(journey);
  }

  async function saveSegment(journeyId, segment, editIdx) {
    const journey = await getJourney(journeyId);
    if (!journey) throw new Error('旅程不存在');

    if (!journey.segments) journey.segments = [];

    if (editIdx >= 0 && journey.segments[editIdx]) {
      journey.segments[editIdx] = segment;
    } else {
      journey.segments.push(segment);
      // sort by day
      journey.segments.sort((a, b) => a.day - b.day);
    }

    return updateJourney(journey);
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
    const rows = all.map(j => ({
      user_id: userId,
      title: j.title,
      status: j.completedAt ? 'completed' : 'ongoing',
      created_at: j.createdAt,
      completed_at: j.completedAt || null,
      is_public: false,
      segments: j.segments || []
    }));

    const { error } = await supabaseClient.from('journeys').insert(rows);
    if (error) {
      console.error('[journeyService] migrate error:', error);
      throw error;
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
    endJourney,
    saveSegment,
    migrateLocalStorage
  };
})();
