'use strict';
(() => {
  const localPage = typeof location !== 'undefined' && (location.protocol === 'file:' || ['localhost', '127.0.0.1'].includes(location.hostname));
  const integrated = document.documentElement?.dataset?.integratedTracker === 'true';
  const API = integrated ? location.origin + '/api/tracker' : localPage ? 'http://127.0.0.1:5518/api/tracker' : 'https://pos-job-assistant.onrender.com/api/tracker';
  if (document.getElementById('discover-jobs')) document.getElementById('discover-jobs').href = integrated ? '/offres' : localPage ? 'http://127.0.0.1:5518/offres' : 'https://pos-job-assistant.onrender.com/offres';
  const CACHE = 'jordan-tracker-cache-v2', OUTBOX = 'jordan-tracker-outbox-v2', AUTH = 'jordan-tracker-session-v2';
  const $ = id => document.getElementById(id);
  const initial = JSON.parse($('applications-data').textContent || '[]');
  const dateFormat = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const read = (store, key, fallback) => { try { return JSON.parse(store.getItem(key)) || fallback; } catch { return fallback; } };
  const VIEW = 'jordan-tracker-hide-applied-v1';
  let hideApplied = read(localStorage, VIEW, false) === true;
  const ARCHIVE_VIEW = 'jordan-tracker-show-archived-v1';
  let hideArchived = read(localStorage, ARCHIVE_VIEW, false) !== true;
  let applications = initial.map(a => ({ ...a, status: a.status || (a.sentAt ? 'applied' : 'pending'), revision: a.revision || 0 }));
  const cached = read(localStorage, CACHE, { applications: [] });
  applications = [...new Map([...applications, ...(Array.isArray(cached.applications) ? cached.applications : [])].map(a => [a.id, a])).values()];
  let outbox = read(localStorage, OUTBOX, {}), auth = integrated ? '@browser' : read(sessionStorage, AUTH, ''), online = false, busy = false, dialogItem = null, sharedFiles = [], feedbackTimer;
  let selectedKinds = new Set(), sending = false, selectionVersion = 0;
  const downloadingDossiers = new Set();
  const ATTACHMENTS = 'jordan-attachment-preferences-v1';
  const attachmentPreferences = read(localStorage, ATTACHMENTS, {});
  let recipientEdited = false, preloadingContacts = false;
  // Retain the original browser storage, including IDs outside the old HTML.
  const legacy = {};
  try {
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter(k => k && (k === 'jordan-candidatures-v1' || k.startsWith('jordan-candidatures-copy-')));
    for (const key of keys) {
      const saved = read(localStorage, key, null);
      if (!saved || saved.version !== 1 || !saved.applications) continue;
      for (const [id, record] of Object.entries(saved.applications)) {
        if (record && validDate(record.sentAt) && (!legacy[id] || record.sentAt > legacy[id].sentAt)) legacy[id] = { sentAt: record.sentAt };
      }
      if (key === 'jordan-candidatures-v1' && !localStorage.getItem('jordan-candidatures-original-v1')) localStorage.setItem('jordan-candidatures-original-v1', JSON.stringify(saved));
    }
    for (const app of applications) if (legacy[app.id] && !app.revision) Object.assign(app, { status: 'applied', sentAt: legacy[app.id].sentAt });
  } catch { /* The export button still works when browser storage is unavailable. */ }

  function validDate(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(v + 'T12:00:00Z').getTime()) && new Date(v + 'T12:00:00Z').toISOString().slice(0, 10) === v; }
  function today() { const d = new Date(); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-'); }
  function node(tag, className, text) { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; }
  function button(text, action, id, className) { const b = node('button', className, text); b.type = 'button'; b.dataset.action = action; b.dataset.id = id; return b; }
  function link(text, url) { const a = node('a', '', text); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; }
  function normalize(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
  function opportunityKind(app) { return /initiativbewerbung|candidature spontan|unsolicited application/i.test(app.role || '') ? 'initiative' : app.opportunityType; }
  function queueGroup(app) { return app.status === 'archived' ? 2 : opportunityKind(app) === 'open-role' ? 0 : opportunityKind(app) === 'initiative' ? 1 : 2; }
  function arrival(app) { return app.addedAt || app.createdAt || ''; }
  function statusGroup(app) { return app.status === 'applied' ? 'sent' : app.status === 'archived' ? 'archived' : 'pending'; }
  function companyKey(app) {
    const key = normalize(app.company).replace(/ß/g, 'ss').replace(/&/g, ' ').replace(/\b(und|gmbh|ag|kg|co|kgaa|se|ug|mbh|inc|ltd|limited|holding|haftungsbeschrankt)\b/g, '').replace(/[^a-z0-9]/g, '');
    return !key || /^(?:employeuraverifier|unbekannt|unknown)$/.test(key) ? 'unknown:' + app.id : key;
  }
  function eligible(app) {
    if (app.status === 'applied' || app.status === 'archived') return true;
    if (app.opportunityType === 'out-of-scope') return false;
    const title = normalize(app.role);
    if (/\b(senior|sr\.?|lead|principal|head of|leiter|leitung)\b/.test(title)) return false;
    if (/ausbildung|auszubild|\bazubi|duales studium|\bfos\b|fachoberschul|\bschulerpraktik|\bschulpraktik|praktik[^\n]{0,20}\bschuler\b/.test(title)) return false;
    const tech = /\bit\b|informatik|software|webentwickl|programmier|\bdata\b|daten|cloud|\bki\b|\bai\b|\bsap\b|\berp\b|\bcrm\b|cyber|security|digital|devops|backend|frontend|full.?stack|netzwerk|embedded|\bux\b|\bui\b|glasfaser|elektrotechnik|systemfuhrung|\bgrc\b|machine learning|computer vision/.test(title);
    if (!tech && /personalentwicklung|human resources|\bhr\b|steuerberatung|umsatzsteuer|wirtschaftspruf|immobilien|sprachdozent|\bverkauf\b|content creator|social media|gestaltung und design|produktionsmanagement|\blogistik\b|\blogistics\b|kommunikation.*kultur|lieferfahr|restaurant|gastronom|\bbooking\b|artist management|weg.verwal|group communications|motion design|finanzen|controlling|konzernentwicklung|online.marketing|\bmarketing\b|talentmanagement|mitarbeiterbindung|strassenbahngleisbau|workplace.*people|investment intern|konstruktion|produktionsentwicklung|kraftfahrzeug/.test(title)) return false;
    return opportunityKind(app) === 'initiative' || /werkstud|working student|student trainee|praktik|prakt\.|internship|\bintern\b|\bstage\b|abschlussarbeit|bachelorarbeit|masterarbeit/.test(title);
  }
  function companyCatalogue() {
    const choices = new Map();
    const priority = (a,b) => Number(a.status === 'applied') - Number(b.status === 'applied') || Number(a.status === 'archived') - Number(b.status === 'archived') || (a.compatibility?.score ?? -1) - (b.compatibility?.score ?? -1) || arrival(a).localeCompare(arrival(b)) || b.id.localeCompare(a.id);
    for (const app of applications) {
      if (!eligible(app)) continue;
      const key = companyKey(app), previous = choices.get(key);
      if (!previous || priority(app, previous) > 0) choices.set(key, app);
    }
    return [...choices.values()];
  }
  function notify(text) { clearTimeout(feedbackTimer); $('feedback').textContent = text; $('feedback').hidden = false; feedbackTimer = setTimeout(() => { $('feedback').hidden = true; }, 5500); }
  function persist() {
    try { localStorage.setItem(CACHE, JSON.stringify({ version: 2, applications })); localStorage.setItem(OUTBOX, JSON.stringify(outbox)); }
    catch { notify('Le navigateur refuse le stockage local. Télécharge une sauvegarde ; les changements reçus par le serveur restent enregistrés.'); }
  }
  function syncLabel(message) {
    const count = Object.keys(outbox).length;
    $('sync-status').textContent = message || (online ? count ? count + ' changement(s) en attente de synchronisation.' : 'Synchronisé · sauvegardé sur le serveur.' : count ? count + ' changement(s) conservé(s) sur cet appareil. Connecte-toi pour les synchroniser.' : initial.length ? 'Mode local · connecte-toi pour retrouver ton suivi sur téléphone.' : 'Connecte-toi pour charger tes entreprises, tes statuts et tes documents.');
    $('connect').textContent = auth ? 'Déconnexion' : 'Se connecter';
    if (integrated) $('connect').hidden = true;
  }
  const labels = { cv: 'CV (PDF)', letter: 'Anschreiben (PDF)', bundle: 'Dossier complet (PDF)', transcript: 'Leistungsübersicht (PDF)', enrollment: 'Studienbescheinigung (PDF)' };
  function cleanDocName(name, kind) {
    if (!name) return kind === 'cv' ? 'Lebenslauf_Jordan_Freddy.pdf' : kind === 'letter' ? 'Anschreiben_Jordan_Freddy.pdf' : 'Dokument.pdf';
    let clean = name.replace(/[-_]?(?:personalisiert|personnalis[eé]|tailored)/gi, '');
    if (kind === 'cv' && (clean === 'Lebenslauf.pdf' || !clean.toLowerCase().includes('lebenslauf'))) clean = 'Lebenslauf_Jordan_Freddy.pdf';
    if (kind === 'letter' && (clean === 'Anschreiben.pdf' || !clean.toLowerCase().includes('anschreiben'))) clean = 'Anschreiben_Jordan_Freddy.pdf';
    return clean || name;
  }
  function cleanMailText(text) {
    if (!text) return text;
    return text.replace(/Meinen\s+auf\s+diese\s+Bewerbung\s+zugeschnittenen\s+Lebenslauf\s+und\s+mein\s+Anschreiben/gi, 'Meinen Lebenslauf und mein Anschreiben');
  }
  function documents(app) {
    if (Array.isArray(app.documents)) return app.documents.map(d => ({ ...d, filename: cleanDocName(d.filename, d.kind) }));
    const docs = [];
    if (app.folder) {
      if (app.cv !== false) docs.push({ kind: 'cv', filename: cleanDocName(app.cvFile, 'cv') });
      if (app.letter !== false) docs.push({ kind: 'letter', filename: cleanDocName(app.letterFile, 'letter') });
      if (app.bundle) docs.push({ kind: 'bundle', filename: app.bundle });
      if (app.transcript) docs.push({ kind: 'transcript', filename: 'Leistungsuebersicht.pdf' });
    }
    return docs;
  }
  function dossierReady(app) { const docs = documents(app); return docs.some(d => d.kind === 'bundle') || docs.some(d => d.kind === 'cv' && !d.isGeneral) && docs.some(d => d.kind === 'letter'); }
  function docButtons(app) {
    const box = node('div', 'links');
    if (documents(app).length) box.append(button('Tout télécharger (.zip)', 'download-all', app.id, 'primary'));
    for (const d of documents(app)) box.append(button(d.kind === 'cv' && d.isGeneral ? 'CV général (PDF)' : labels[d.kind] || d.kind, 'document:' + d.kind, app.id));
    return box;
  }
  function card(app) {
    const article = node('article', 'card'); article.dataset.id = app.id;
    const info = node('div'); const title = node('h3', '', app.company); title.id = 'title-' + app.id; article.setAttribute('aria-labelledby', title.id); info.append(title, node('p', 'role', app.role));
    if (app.location) info.append(node('p', 'meta', app.location));
    const badge = opportunityKind(app) === 'open-role' ? 'Offre publiée' : opportunityKind(app) === 'initiative' ? 'Candidature spontanée' : app.historical ? 'Ancien dossier' : 'Dossier existant';
    info.append(node('span', 'badge' + (app.historical ? ' historical' : ''), badge));
    {
      const match = app.compatibility || { score: null, reasons: [], warnings: ['Le score sera disponible après synchronisation avec le suivi à jour.'] };
      const label = typeof match.score !== 'number' ? 'Compatibilité CV : à préciser' : (match.basis === 'description' ? 'Compatibilité CV : ' : 'Compatibilité CV estimée : ') + match.score + ' %';
      const details = node('details', 'compatibility'); details.append(node('summary', '', label));
      if (typeof match.score !== 'number') details.append(node('p', 'meta', 'Informations insuffisantes sur le poste pour calculer un pourcentage fiable.'));
      for (const reason of [...(match.reasons || []), ...(match.warnings || [])]) details.append(node('p', 'meta', reason));
      details.append(node('p', 'meta', 'Score indicatif, pas une probabilité d’embauche.')); info.append(details);
    }
    if (app.researchNeedsReview) info.append(node('span', 'badge historical', 'Brouillon · employeur à vérifier'));
    if (app.status === 'applied') info.append(node('p', 'meta', app.sentAt ? 'Postulée le ' + dateFormat.format(new Date(app.sentAt + 'T12:00:00')) : 'Déjà postulée · date non renseignée'));
    if (app.status === 'unknown') info.append(node('p', 'meta', 'Envoi à confirmer'));
    if (app.preparationMethod === 'profile-template') info.append(node('p', 'meta', 'CV et lettre préparés localement à partir de ton profil et de l’annonce. Version structurée à relire avant envoi.'));
    if (app.status === 'archived') info.append(node('p', 'meta', 'Écartée / archivée · hors des candidatures à envoyer'));
    if (app.note) info.append(node('p', 'note', app.note));
    if (app.addedAt || app.verifiedAt) info.append(node('p', 'meta', 'Ajout / vérification : ' + (app.verifiedAt || app.addedAt)));
    const docs = docButtons(app); if (docs.childElementCount) info.append(docs);
    if (!documents(app).some(d => d.kind === 'letter')) info.append(node('p', 'meta', 'Lettre adaptée à préparer. CV général disponible après connexion.'));
    const sources = node('div', 'links');
    if (app.email) {
      const prefix = app.applicationChannel === 'portal-only' || app.contactPurpose === 'questions' ? 'Contact (questions) : ' : app.emailKind === 'general' ? 'Contact général : ' : '';
      sources.append(link(prefix + app.email, 'mailto:' + app.email));
      if (app.emailSource && /^https?:/.test(app.emailSource)) sources.append(link('Source du contact ↗', app.emailSource));
    }
    if (app.contactMessage) info.append(node('p', 'meta', app.contactMessage));
    if (app.url) sources.append(link(app.opportunityType === 'initiative' ? 'Site / carrière ↗' : 'Annonce / formulaire ↗', app.url));
    if (app.sourceUrl) sources.append(link(app.sourceLabel || 'Source', app.sourceUrl));
    if (Array.isArray(app.sourceUrls)) app.sourceUrls.slice(0, 2).filter(u => u !== app.url).forEach((u, i) => sources.append(link('Source officielle ' + (i + 1), u)));
    if (sources.childElementCount) info.append(sources);
    const actions = node('div', 'actions');
    if (app.status !== 'archived') actions.append(button('Préparer l’e-mail', 'prepare', app.id));
    if (app.status !== 'applied' && app.status !== 'archived' && !dossierReady(app) && app.jobAssistantId) actions.append(button('Préparer CV + lettre', 'prepare-documents', app.id, 'primary'));
    if (app.status !== 'archived') {
      const assistant = link('Aide au formulaire', (integrated ? location.origin : localPage ? 'http://127.0.0.1:5518' : 'https://pos-job-assistant.onrender.com') + '/dossier/' + encodeURIComponent(app.id)); assistant.className = 'button'; actions.append(assistant);
    }
    if (app.status === 'applied') actions.append(button('Remettre à postuler', 'state:pending', app.id, 'undo'));
    else if (app.status === 'archived') actions.append(button('Remettre à postuler', 'state:pending', app.id));
    else {
      actions.append(button('Marquer un envoi fait ailleurs', 'state:applied', app.id));
      if (app.status === 'unknown') actions.append(button('À postuler', 'state:pending', app.id));
      actions.append(button('Je ne peux pas postuler', 'state:archived', app.id, 'undo'));
    }
    if (outbox[app.id]) info.append(node('p', 'meta', 'Changement en attente de synchronisation.'));
    article.append(info, actions); return article;
  }
  function render() {
    $('sent-section').hidden = hideApplied;
    $('toggle-applied').setAttribute('title', hideApplied ? 'Afficher les postulées' : 'Masquer les postulées');
    $('toggle-applied').setAttribute('aria-expanded', String(!hideApplied));
    $('archived-section').hidden = hideArchived;
    $('toggle-archived').setAttribute('title', hideArchived ? 'Afficher les écartées / archivées' : 'Masquer les écartées / archivées');
    $('toggle-archived').setAttribute('aria-expanded', String(!hideArchived));
    const q = normalize($('search').value), region = $('region').value, type = $('opportunity').value;
    const catalogue = $('catalogue')?.value || 'all';
    const selected = companyCatalogue().filter(a => catalogue === 'all' || (catalogue === 'new' ? a.id.startsWith('job-') : !a.id.startsWith('job-')));
    const visible = selected.filter(a => (!q || normalize([a.company, a.role, a.location, a.sector].join(' ')).includes(q)) && (!region || a.region === region || region === 'school' && a.schoolList || region === 'Historique' && a.historical) && (!type || (type === 'historical' ? a.historical : opportunityKind(a) === type)));
    const groups = { sent: visible.filter(a => statusGroup(a) === 'sent'), pending: visible.filter(a => statusGroup(a) === 'pending'), archived: visible.filter(a => statusGroup(a) === 'archived') };
    groups.sent.sort((a, b) => (b.sentAt || '').localeCompare(a.sentAt || '') || a.company.localeCompare(b.company));
    groups.pending.sort((a, b) => queueGroup(a) - queueGroup(b) || (queueGroup(a) === 0 ? (b.compatibility?.score ?? -1) - (a.compatibility?.score ?? -1) : 0) || arrival(b).localeCompare(arrival(a)) || a.company.localeCompare(b.company));
    groups.archived.sort((a, b) => (b.updatedAt || arrival(b)).localeCompare(a.updatedAt || arrival(a)) || a.company.localeCompare(b.company));
    for (const [name, list] of Object.entries(groups)) {
      const content = []; let previousGroup = -1;
      for (const app of list) {
        const group = queueGroup(app);
        if (name === 'pending' && group !== previousGroup) {
          const headings = ['Offres publiées · par compatibilité CV','Candidatures spontanées · plus récentes d’abord','Autres dossiers conservés'];
          content.push(node('h3', 'queue-heading', headings[group])); previousGroup = group;
        }
        content.push(card(app));
      }
      $('' + name + '-list').replaceChildren(...content);
      if (!list.length) $(name + '-list').append(node('p', 'empty', applications.length ? 'Aucune candidature dans cette liste avec ces filtres.' : 'Connecte-toi pour charger tes entreprises et tes documents.'));
      $(name + '-count').textContent = list.length; $(name + '-total').textContent = selected.filter(a => statusGroup(a) === name).length;
    }
    $('overview').textContent = applications.length ? new Set(selected.map(a => normalize(a.company))).size + ' entreprises · ' + selected.length + ' fiches affichées · ' + applications.length + ' fiches conservées au total' : 'Ton suivi apparaît après connexion.';
    if (!applications.length) for (const name of ['sent', 'pending', 'archived']) { $(name + '-count').textContent = '—'; $(name + '-total').textContent = '—'; }
    syncLabel();
  }
  async function request(path = '', options = {}) {
    const headers = { ...(options.headers || {}) }; if (auth && auth !== '@browser') headers.Authorization = auth;
    const response = await fetch(API + path, { ...options, headers, cache: 'no-store', signal: options.signal || AbortSignal.timeout(90000) });
    if (response.status === 401) {
      auth = ''; online = false;
      try { sessionStorage.removeItem(AUTH); } catch {}
      $('login-form').hidden = false;
      syncLabel();
      throw new Error('Connexion refusée. Vérifie ton identifiant et ton mot de passe.');
    }
    return response;
  }
  function overlayOutbox() { for (const app of applications) if (outbox[app.id]) Object.assign(app, { status: outbox[app.id].status, sentAt: outbox[app.id].sentAt }); }
  async function synchronize() {
    if (!auth || busy) return;
    busy = true; syncLabel('Connexion au serveur… Il peut mettre un moment à démarrer.');
    try {
      let response = await request(); if (!response.ok) throw new Error('Serveur indisponible (' + response.status + ').');
      let payload = await response.json();
      const recoverable = Object.fromEntries(Object.entries(legacy).filter(([id]) => !outbox[id]));
      if (Object.keys(recoverable).length) {
        response = await request('/import-statuses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ applications: recoverable }) });
        if (!response.ok) throw new Error('Récupération des anciens statuts impossible.');
        const imported = await response.json(); payload = { applications: imported.applications }; if (imported.imported) notify(imported.imported + ' ancien(s) statut(s) « postulé » récupéré(s).');
      }
      if (!Array.isArray(payload.applications)) throw new Error('Réponse du serveur invalide.');
      applications = payload.applications; online = true; overlayOutbox(); persist(); render();
      // Each action includes the revision seen by the device. A stale tab cannot
      // silently undo a status saved from another device.
      for (const [id, change] of Object.entries(outbox)) {
        const response = await request('/' + encodeURIComponent(id) + '/state', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) });
        const result = await response.json();
        if (response.status === 409 && result.application) {
          const same = result.application.status === change.status && result.application.sentAt === change.sentAt;
          if (!same) notify(result.error || 'Une modification plus récente existe sur un autre appareil.');
        } else if (!response.ok) throw new Error(result.error || 'Enregistrement impossible.');
        if (result.application) { applications = applications.map(a => a.id === id ? result.application : a); delete outbox[id]; persist(); render(); }
      }
      $('login-form').hidden = true; $('login-error').textContent = ''; syncLabel();
    } catch (error) { online = false; syncLabel(error.message + ' Les changements locaux restent conservés.'); $('login-error').textContent = error.message; if (!applications.length) $('login-form').hidden = false; persist(); }
    finally { busy = false; if (online) preloadContacts(); }
  }
  async function preloadContacts() {
    if (!auth || preloadingContacts || document.hidden) return;
    preloadingContacts = true; let retry = false, delay = 2000;
    if ($('contact-preload-status')) $('contact-preload-status').textContent = 'Préchargement des contacts en arrière-plan… Les adresses déjà connues restent disponibles.';
    try {
      const response = await request('/contacts/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) return;
      const result = await response.json();
      for (const update of result.updates || []) {
        applications = applications.map(app => app.id === update.id ? { ...app, ...update.contacts } : app);
        if (dialogItem?.id === update.id) {
          Object.assign(dialogItem, update.contacts);
          if (!sending && !recipientEdited && !$('mail-to').value && update.contacts.email) $('mail-to').value = update.contacts.email;
        }
      }
      if (result.updates?.length) { persist(); render(); }
      retry = result.remaining > 0 && (result.busy || result.updates?.length > 0); delay = result.busy ? 10000 : 2000;
      if ($('contact-preload-status')) $('contact-preload-status').textContent = result.remaining > 0 ? 'Contacts : ' + result.remaining + ' fiche(s) à vérifier en arrière-plan. Tu peux déjà utiliser les adresses préchargées.' : 'Vérification des contacts terminée. Les adresses publiques trouvées sont conservées ; les autres fiches utilisent leur formulaire officiel.';
    } catch { /* Known addresses remain cached and visible if a preload fails. */ }
    finally { preloadingContacts = false; if (retry) setTimeout(preloadContacts, delay); }
  }
  async function changeState(app, status) {
    if (outbox[app.id] && busy) { notify('Cette fiche est en cours de sauvegarde.'); return; }
    const leavesPending = status === 'applied' || status === 'archived';
    const nextId = leavesPending ? nextPendingId(app.id) : null;
    const sentAt = status === 'applied' ? app.status === 'unknown' ? null : today() : null;
    outbox[app.id] = { status, sentAt, revision: outbox[app.id]?.revision ?? app.revision ?? 0 };
    Object.assign(app, { status, sentAt }); persist(); render();
    notify(online ? 'Enregistrement du statut…' : 'Statut conservé sur cet appareil ; connexion nécessaire pour le synchroniser.');
    await synchronize();
    if (leavesPending && applications.find(a => a.id === app.id)?.status === status) continuePending(nextId);
    if (online && !outbox[app.id]) notify('Statut enregistré sur le serveur.');
  }
  function nextPendingId(id) {
    const cards = [...$('pending-list').querySelectorAll('.card')];
    const index = cards.findIndex(card => card.dataset.id === id);
    return cards[index + 1]?.dataset.id || cards.find(card => card.dataset.id !== id)?.dataset.id || null;
  }
  function continuePending(nextId) {
    hideApplied = true;
    try { localStorage.setItem(VIEW, JSON.stringify(true)); } catch {}
    render();
    const next = [...$('pending-list').querySelectorAll('.card')].find(card => card.dataset.id === nextId) || $('pending-list').querySelector('.card') || $('pending-section');
    next.tabIndex = -1;
    next.focus({ preventScroll: true });
    next.scrollIntoView({ behavior: 'instant', block: 'start' });
  }
  function downloadBlob(blob, filename) { const url = URL.createObjectURL(blob); const a = node('a'); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
  async function getDocument(app, kind) {
    const doc = documents(app).find(d => d.kind === kind); if (!doc) throw new Error('Ce document n’est pas encore préparé.');
    const response = await request('/' + encodeURIComponent(app.id) + '/documents/' + kind); if (!response.ok) throw new Error('Document indisponible. Connecte-toi ou actualise le suivi.');
    const filename = cleanDocName(doc.filename, kind);
    return new File([await response.blob()], filename, { type: doc.contentType || 'application/pdf' });
  }
  async function downloadDocument(app, kind) {
    if (!auth && initial.length && app.folder) {
      const doc = documents(app).find(d => d.kind === kind);
      if (doc) {
        const a = node('a');
        const filename = cleanDocName(doc.filename, kind);
        a.href = doc.isGeneral ? './Lebenslauf%20jordan.pdf' : '../' + encodeURIComponent(app.folder) + '/' + encodeURIComponent(filename);
        a.download = filename;
        document.body.append(a); a.click(); a.remove(); return;
      }
    }
    if (!auth) throw new Error('Connecte-toi pour télécharger les documents depuis ton téléphone.');
    const file = await getDocument(app, kind); downloadBlob(file, file.name);
  }
  function safeArchiveName(value, fallback) {
    const name = Array.from(String(value || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '')).slice(0, 120).join('');
    return !name || /^\.+$/.test(name) ? fallback : /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? '_' + name : name;
  }
  function dossierZip(entries) {
    // ZIP STORE keeps the original PDF bytes, with UTF-8 paths and a central directory.
    const localParts = [], centralParts = [], encoder = new TextEncoder(); let offset = 0;
    for (const entry of entries) {
      const name = encoder.encode(entry.name), bytes = entry.bytes;
      let crc = 0xffffffff;
      for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
      crc = (crc ^ 0xffffffff) >>> 0;
      const local = new Uint8Array(30), l = new DataView(local.buffer);
      l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x800, true); l.setUint16(12, 33, true);
      l.setUint32(14, crc, true); l.setUint32(18, bytes.length, true); l.setUint32(22, bytes.length, true); l.setUint16(26, name.length, true);
      const central = new Uint8Array(46), c = new DataView(central.buffer);
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true); c.setUint16(14, 33, true);
      c.setUint32(16, crc, true); c.setUint32(20, bytes.length, true); c.setUint32(24, bytes.length, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
      localParts.push(local, name, bytes); centralParts.push(central, name); offset += local.length + name.length + bytes.length;
    }
    const centralLength = centralParts.reduce((sum, part) => sum + part.length, 0), end = new Uint8Array(22), e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true); e.setUint32(12, centralLength, true); e.setUint32(16, offset, true);
    return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
  }
  async function downloadDossier(app) {
    if (!auth) throw new Error('Connecte-toi pour télécharger le dossier complet.');
    const docs = documents(app); if (!docs.length) throw new Error('Aucun document disponible pour cette candidature.');
    const folder = safeArchiveName(app.company, 'Bewerbung'), names = new Set();
    const files = [];
    for (const doc of docs) {
      try {
        const file = await getDocument(app, doc.kind);
        files.push({ file, kind: doc.kind });
      } catch (err) {
        console.warn('Document non récupéré pour le zip:', doc.kind, err);
      }
    }
    if (!files.length) throw new Error('Document indisponible. Connecte-toi ou actualise le suivi.');
    const entries = [];
    for (const item of files) {
      const bytes = new Uint8Array(await item.file.arrayBuffer());
      if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') continue;
      const base = safeArchiveName(item.file.name, item.kind + '.pdf'); let name = base, number = 1;
      while (names.has(name.toLowerCase())) name = base.replace(/(\.[^.]+)?$/i, '_' + (++number) + '$1');
      names.add(name.toLowerCase()); entries.push({ name: folder + '/' + name, bytes });
    }
    if (!entries.length) throw new Error('Aucun PDF valide n’a pu être inclus dans le dossier.');
    downloadBlob(dossierZip(entries), folder + '.zip');
    notify(entries.length + ' document(s) téléchargé(s) dans ' + folder + '.zip. Décompresse-le pour retrouver les PDF.');
  }
  function emailDraft(app) {
    const rawBody = app.mailBody || 'Sehr geehrte Damen und Herren,\n\nich bewerbe mich initiativ bei ' + app.company + ' als Werkstudent oder Praktikant im Bereich Softwareentwicklung / IT. Ich studiere Bachelor Informatik an der Technischen Hochschule Mittelhessen in Gießen. In meinen Projekten arbeite ich mit Next.js, TypeScript, Java, REST-Schnittstellen und Datenbanken.\n\nIm Anhang finden Sie meinen Lebenslauf. Über eine Rückmeldung und ein Kennenlernen freue ich mich.\n\nMit freundlichen Grüßen\nJordan Freddy';
    return { subject: app.mailSubject || 'Initiativbewerbung als Werkstudent / Praktikant Softwareentwicklung / IT – Jordan Freddy', body: cleanMailText(rawBody) };
  }
  async function refreshSelectedFiles(app) {
    const version = ++selectionVersion;
    sharedFiles = []; $('share-files').disabled = true;
    if (!auth) return;
    try {
      const files = await Promise.all([...selectedKinds].map(kind => getDocument(app, kind)));
      if (dialogItem?.id !== app.id || version !== selectionVersion) return;
      sharedFiles = files;
      $('share-files').disabled = !files.length || !navigator.canShare || !navigator.canShare({ files });
    } catch { /* Downloads remain available individually. */ }
  }
  function renderAttachmentSelection(app) {
    const box = node('div', 'attachment-selection');
    if (documents(app).length) { const all = button('Tout télécharger (.zip)', 'download-all', app.id); all.disabled = sending; box.append(all); }
    const labels = { cv: 'CV', letter: 'Anschreiben', transcript: 'Leistungsübersicht', enrollment: 'Studienbescheinigung', bundle: 'Dossier PDF complet' };
    for (const doc of documents(app)) {
      const included = selectedKinds.has(doc.kind);
      const row = node('div', 'attachment-row' + (included ? '' : ' attachment-removed'));
      const name = button((labels[doc.kind] || doc.kind) + ' · ' + doc.filename, 'document:' + doc.kind, app.id);
      const toggle = node('button', '', included ? 'Retirer de l’envoi' : 'Ajouter à l’envoi');
      toggle.type = 'button'; toggle.disabled = sending;
      toggle.setAttribute('aria-label', (included ? 'Retirer ' : 'Ajouter ') + (labels[doc.kind] || doc.kind) + (included ? ' de l’envoi' : ' à l’envoi'));
      toggle.addEventListener('click', () => {
        if (sending) return;
        if (included) selectedKinds.delete(doc.kind);
        else { if (doc.kind === 'bundle') { selectedKinds.delete('cv'); selectedKinds.delete('letter'); } else if (['cv','letter'].includes(doc.kind)) selectedKinds.delete('bundle'); selectedKinds.add(doc.kind); }
        const defaults = defaultAttachmentKinds(app);
        attachmentPreferences[app.id] = { removed: defaults.filter(kind => !selectedKinds.has(kind)), added: [...selectedKinds].filter(kind => !defaults.includes(kind)) };
        try { localStorage.setItem(ATTACHMENTS, JSON.stringify(attachmentPreferences)); } catch { /* Current selection remains in memory. */ }
        // Keep the attachment sentence accurate after removing a letter or CV.
        $('mail-body').value = $('mail-body').value.replace(/Meinen Lebenslauf und mein Anschreiben finden Sie im Anhang\.|Meinen Lebenslauf finden Sie im Anhang\.|Mein Anschreiben finden Sie im Anhang\.|Die ausgewählten Unterlagen finden Sie im Anhang\./g,
          selectedKinds.has('bundle') || selectedKinds.has('cv') && selectedKinds.has('letter') ? 'Meinen Lebenslauf und mein Anschreiben finden Sie im Anhang.' : selectedKinds.has('cv') ? 'Meinen Lebenslauf finden Sie im Anhang.' : selectedKinds.has('letter') ? 'Mein Anschreiben finden Sie im Anhang.' : selectedKinds.size ? 'Die ausgewählten Unterlagen finden Sie im Anhang.' : '');
        renderAttachmentSelection(app); refreshSelectedFiles(app);
      });
      row.append(name, toggle); box.append(row);
    }
    $('dialog-documents').replaceChildren(box);
    $('document-note').textContent = selectedKinds.size + ' pièce(s) jointe(s) sélectionnée(s). Toutes les pièces disponibles sont ajoutées par défaut, dont le relevé de notes. Tes retraits restent mémorisés pour cette candidature sur cet appareil ; les fichiers restent dans ton dossier.';
  }
  function defaultAttachmentKinds(app) {
    const available = new Set(documents(app).map(doc => doc.kind));
    const extras = ['transcript','enrollment'].filter(kind => available.has(kind));
    return available.has('bundle') && !(available.has('cv') && available.has('letter')) ? ['bundle',...extras] : ['cv','letter',...extras].filter(kind => available.has(kind));
  }
  async function openApplication(app) {
    if (sending) return;
    dialogItem = app; sharedFiles = []; const draft = emailDraft(app);
    const savedPreference = attachmentPreferences[app.id];
    const preference = savedPreference && Array.isArray(savedPreference.removed) && Array.isArray(savedPreference.added) ? savedPreference : { removed: [], added: [] };
    const available = new Set(documents(app).map(doc => doc.kind));
    selectedKinds = new Set([...defaultAttachmentKinds(app).filter(kind => !preference.removed.includes(kind)), ...preference.added.filter(kind => available.has(kind))]);
    if (selectedKinds.has('bundle') && (selectedKinds.has('cv') || selectedKinds.has('letter'))) selectedKinds.delete('bundle');
    recipientEdited = false;
    $('dialog-title').textContent = app.company; $('dialog-role').textContent = app.role;
    if (app.researchNeedsReview) $('dialog-role').textContent += ' · BROUILLON À VÉRIFIER : ' + (app.researchWarnings || []).join(' ');
    $('mail-to').value = app.email || ''; $('mail-subject').value = draft.subject; $('mail-body').value = draft.body;
    renderAttachmentSelection(app); $('portal-action').replaceChildren();
    if ($('contact-suggestions')) { $('contact-suggestions').replaceChildren(); $('contact-suggestions').hidden = true; }
    if ($('contact-suggestions') && Array.isArray(app.contactCandidates) && app.contactCandidates.length) {
      for (const candidate of app.contactCandidates) {
        const choice = node('button', 'contact-pill', candidate.email + (candidate.kind === 'recruiting' ? ' · recrutement' : ' · contact général')); choice.type = 'button';
        choice.onclick = () => { recipientEdited = true; $('mail-to').value = candidate.email; };
        $('contact-suggestions').append(choice); if (candidate.sourceUrl) $('contact-suggestions').append(link('Source de l’adresse ↗',candidate.sourceUrl));
      }
      $('contact-suggestions').hidden = false;
    }
    const applicationUrl = app.applicationChannel === 'portal-only' && app.contactPortalUrl || app.url;
    if (applicationUrl) { const a = link(app.email ? 'Voir aussi le site / formulaire ↗' : 'Ouvrir le site / formulaire pour postuler ↗', applicationUrl); a.className = 'button'; $('portal-action').append(a); }
    if (app.contactMessage) $('portal-action').append(node('p', 'meta', app.contactMessage));
    $('portal-action').append(node('p', 'meta', 'Ouvrir cet aperçu ou le site ne transmet rien. Seul le bouton « Envoyer la candidature (Gmail) » envoie cet e-mail et enregistre le statut Postulé.'));
    $('dialog-feedback').textContent = app.status === 'applied' ? 'Déjà marquée Postulé' + (app.sentAt ? ' le ' + dateFormat.format(new Date(app.sentAt + 'T12:00:00')) : '') + '. Aucun renvoi proposé. Si ce statut est incorrect, utilise « Remettre à postuler » sur la fiche.' : '';
    if ($('send-mail')) { $('send-mail').disabled = app.status === 'applied'; $('send-mail').textContent = app.status === 'applied' ? 'Déjà postulée' : '🚀 Envoyer la candidature (Gmail)'; }
    if (app.status !== 'applied' && !dossierReady(app)) {
      $('send-mail').disabled = true; $('send-mail').textContent = 'CV ciblé et lettre à préparer';
      $('dialog-feedback').textContent = 'Dossier incomplet : prépare le CV ciblé et la lettre de motivation avant l’envoi.';
      if (app.jobAssistantId) $('portal-action').append(button('Préparer CV + lettre', 'prepare-documents', app.id, 'primary'));
    }
    if (app.applicationChannel === 'portal-only' || app.contactPurpose === 'questions') {
      $('send-mail').disabled = true; $('send-mail').textContent = 'Candidater via le formulaire';
      $('dialog-feedback').textContent = 'Cet employeur utilise un formulaire officiel. Ouvre le lien ci-dessus et utilise les documents du dossier.';
    }
    $('share-files').disabled = true; $('application-dialog').showModal();
    if (auth) {
      if (!$('mail-to').value && !app.researchNeedsReview && app.applicationChannel !== 'portal-only') {
        if (app.status !== 'applied') $('dialog-feedback').textContent = 'Recherche d’adresse e-mail officielle en cours…';
        try {
          const res = await request('/' + encodeURIComponent(app.id) + '/contacts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          if (res.ok) {
            const data = await res.json();
            if (dialogItem?.id === app.id) {
              if (data.candidates && data.candidates.length) {
                if (!recipientEdited && !$('mail-to').value) $('mail-to').value = data.candidates[0].email;
                Object.assign(app, { email: app.email || data.candidates[0].email, emailSource: data.candidates[0].sourceUrl, emailKind: data.candidates[0].kind, contactCandidates: data.candidates, contactCheckedAt: data.checkedAt, contactStatus: data.outcome, contactMessage: data.message, contactPortalUrl: data.portalUrl, ...(data.applicationChannel ? { applicationChannel: data.applicationChannel } : {}), ...(data.contactPurpose ? { contactPurpose: data.contactPurpose } : {}) }); persist(); render();
                if (app.applicationChannel === 'portal-only' || app.contactPurpose === 'questions') {
                  $('send-mail').disabled = true; $('send-mail').textContent = 'Candidater via le formulaire';
                  if (app.contactPortalUrl) { const portal = $('portal-action').querySelector('a'); if (portal) portal.href = app.contactPortalUrl; }
                }
                if ($('contact-suggestions')) {
                  $('contact-suggestions').replaceChildren();
                  for (const cand of data.candidates) {
                    const pill = node('button', 'contact-pill', cand.email + (cand.kind === 'recruiting' ? ' (recrutement)' : ''));
                    pill.type = 'button';
                    pill.onclick = () => { $('mail-to').value = cand.email; };
                    $('contact-suggestions').append(pill);
                  }
                  $('contact-suggestions').hidden = false;
                }
                if (app.status !== 'applied') $('dialog-feedback').textContent = data.message || '';
              } else {
                if (app.status !== 'applied') $('dialog-feedback').textContent = data.message || 'Aucune adresse e-mail publique trouvée. Postule sur le site ou renseigne une adresse.';
              }
            }
          } else if (dialogItem?.id === app.id && app.status !== 'applied') $('dialog-feedback').textContent = 'Recherche de contact indisponible. Les adresses déjà connues restent conservées ; aucun destinataire n’est inventé.';
        } catch { if (dialogItem?.id === app.id && app.status !== 'applied') $('dialog-feedback').textContent = 'Recherche de contact interrompue. Utilise l’adresse connue ou le formulaire officiel.'; }
      }
      if (dialogItem?.id === app.id) await refreshSelectedFiles(app);
    }
  }
  document.addEventListener('click', async event => {
    const b = event.target.closest('button[data-action]'); if (!b) return;
    const app = applications.find(a => a.id === b.dataset.id); if (!app) return;
    try {
      if (b.dataset.action === 'download-all') {
        if (downloadingDossiers.has(app.id)) return;
        downloadingDossiers.add(app.id); b.disabled = true; const label = b.textContent; b.textContent = 'Téléchargement du dossier…';
        try { await downloadDossier(app); } finally { downloadingDossiers.delete(app.id); b.disabled = false; b.textContent = label; }
      } else if (b.dataset.action === 'prepare-documents') {
        b.disabled = true; b.textContent = 'Préparation du CV et de la lettre…'; notify('Préparation du dossier personnalisé en cours. Aucun envoi de mail.');
        const response = await request('/' + encodeURIComponent(app.id) + '/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(240000) });
        const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Préparation indisponible. Réessaie depuis le dossier.');
        applications = applications.map(a => a.id === app.id ? data.application : a); persist(); render();
        if (dialogItem?.id === app.id) { $('application-dialog').close(); await openApplication(data.application); }
        notify('CV ciblé et lettre disponibles. Aucun e-mail envoyé.');
      } else if (b.dataset.action === 'prepare') await openApplication(app); else if (b.dataset.action.startsWith('state:')) await changeState(app, b.dataset.action.split(':')[1]); else if (b.dataset.action.startsWith('document:')) await downloadDocument(app, b.dataset.action.split(':')[1]);
    }
    catch (error) { notify(error.message); if (b.dataset.action === 'prepare-documents') { b.disabled = false; b.textContent = 'Réessayer la préparation'; if (dialogItem?.id === app.id) $('dialog-feedback').textContent = error.message; } }
  });
  for (const id of ['search', 'region', 'opportunity']) $(id).addEventListener('input', render);
  $('catalogue')?.addEventListener('change', render);
  $('rank-sort')?.addEventListener('change', render);
  $('toggle-applied').addEventListener('click', () => {
    hideApplied = !hideApplied;
    try { localStorage.setItem(VIEW, JSON.stringify(hideApplied)); } catch {}
    render();
  });
  $('toggle-archived').addEventListener('click', () => {
    hideArchived = !hideArchived;
    try { localStorage.setItem(ARCHIVE_VIEW, JSON.stringify(!hideArchived)); } catch {}
    render();
    if (!hideArchived) $('archived-section').scrollIntoView({ block: 'start' });
  });
  $('connect').addEventListener('click', () => { if (auth) { auth = ''; online = false; sessionStorage.removeItem(AUTH); syncLabel(); } else { $('login-form').hidden = !$('login-form').hidden; if (!$('login-form').hidden) $('password').focus(); } });
  $('login-form').addEventListener('submit', async event => { event.preventDefault(); auth = 'Basic ' + btoa(unescape(encodeURIComponent($('username').value.trim() + ':' + $('password').value))); try { sessionStorage.setItem(AUTH, JSON.stringify(auth)); } catch {} $('password').value = ''; await synchronize(); });
  $('refresh').addEventListener('click', () => { if (!auth) { $('login-form').hidden = false; $('password').focus(); } else synchronize(); });
  $('close-dialog').addEventListener('click', () => { if (sending) return; $('application-dialog').close(); dialogItem = null; });
  $('mail-to').addEventListener('input', () => { recipientEdited = true; });
  $('application-dialog').addEventListener('cancel', event => { if (sending) event.preventDefault(); });
  $('send-mail')?.addEventListener('click', async () => {
    if (!dialogItem) return;
    if (!dossierReady(dialogItem)) { $('dialog-feedback').textContent = 'Prépare le CV ciblé et la lettre avant de pouvoir envoyer.'; return; }
    if (dialogItem.status === 'applied') { $('send-mail').disabled = true; $('send-mail').textContent = 'Déjà postulée'; $('dialog-feedback').textContent = 'Cette candidature est déjà marquée Postulé. Vérifie le précédent envoi ; aucun renvoi automatique.'; return; }
    if (!auth) {
      $('dialog-feedback').textContent = 'Connecte-toi à ton suivi pour envoyer la candidature.';
      $('login-form').hidden = false;
      $('password').focus();
      return;
    }
    const to = $('mail-to').value.trim();
    if (!to || !$('mail-to').checkValidity()) {
      $('mail-to').focus();
      $('dialog-feedback').textContent = 'Renseigne une adresse e-mail valide pour le destinataire.';
      return;
    }
    const subject = $('mail-subject').value.trim();
    const body = $('mail-body').value.trim();
    if (!subject || !body) {
      $('dialog-feedback').textContent = 'L’objet et le corps de l’e-mail ne peuvent pas être vides.';
      return;
    }
    const sendBtn = $('send-mail');
    const sendingItem = dialogItem;
    const attachmentKinds = [...selectedKinds];
    sending = true; renderAttachmentSelection(sendingItem);
    for (const id of ['mail-to', 'mail-subject', 'mail-body', 'close-dialog']) $(id).disabled = true;
    sendBtn.disabled = true;
    sendBtn.textContent = 'Vérification…';
    $('dialog-feedback').textContent = 'Vérification du dossier et des pièces jointes…';
    try {
      const reviewRes = await request('/' + encodeURIComponent(sendingItem.id) + '/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, body, attachmentKinds })
      });
      const reviewData = await reviewRes.json();
      if (!reviewRes.ok) throw new Error(reviewData.error || 'Vérification impossible.');
      if (JSON.stringify(reviewData.attachments.map(d => d.kind).sort()) !== JSON.stringify([...attachmentKinds].sort())) throw new Error('Le serveur doit être actualisé pour respecter les pièces retirées. Aucun mail envoyé.');
      if (!reviewData.enabled) throw new Error(reviewData.reason || 'L’envoi Gmail n’est pas disponible.');

      sendBtn.textContent = 'Envoi Gmail en cours…';
      $('dialog-feedback').textContent = 'Envoi via ' + reviewData.sender + ' avec ' + reviewData.attachments.length + ' pièce(s) jointe(s)…';

      const sendRes = await request('/' + encodeURIComponent(sendingItem.id) + '/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true, token: reviewData.token })
      });
      const sendData = await sendRes.json();
      if (!sendRes.ok) throw new Error(sendData.error || 'Erreur lors de l’envoi.');

      const sentItem = sendingItem;
      const nextId = nextPendingId(sentItem.id);
      const updated = sendData.application || { ...sentItem, status: 'applied', sentAt: today(), revision: (sentItem.revision || 0) + 1 };
      applications = applications.map(a => a.id === sentItem.id ? updated : a);
      delete outbox[sentItem.id];
      persist();
      notify('✓ Candidature envoyée à ' + sentItem.company + '. Tu peux continuer avec les non postulées.');

      $('application-dialog').close();
      dialogItem = null;

      continuePending(nextId);
    } catch (error) {
      const alreadyApplied = /déjà marquée Postulé/i.test(error.message);
      sendBtn.disabled = alreadyApplied;
      sendBtn.textContent = alreadyApplied ? 'Déjà postulée' : '🚀 Réessayer l’envoi';
      $('dialog-feedback').textContent = error.message;
    } finally {
      sending = false;
      for (const id of ['mail-to', 'mail-subject', 'mail-body', 'close-dialog']) $(id).disabled = false;
      if (dialogItem) renderAttachmentSelection(dialogItem);
    }
  });
  $('copy-mail').addEventListener('click', async () => { try { await navigator.clipboard.writeText('An: ' + $('mail-to').value + '\nBetreff: ' + $('mail-subject').value + '\n\n' + $('mail-body').value); $('dialog-feedback').textContent = 'E-mail copié.'; } catch { $('mail-body').select(); $('dialog-feedback').textContent = 'Sélectionne et copie le texte.'; } });
  $('open-mail').addEventListener('click', () => { if (!$('mail-to').value || !$('mail-to').checkValidity()) { $('mail-to').focus(); $('dialog-feedback').textContent = 'Renseigne l’adresse du destinataire ou utilise le formulaire de l’entreprise.'; return; } location.href = 'mailto:' + encodeURIComponent($('mail-to').value) + '?subject=' + encodeURIComponent($('mail-subject').value) + '&body=' + encodeURIComponent($('mail-body').value); });
  $('download-eml').addEventListener('click', async () => { if (!auth) { $('dialog-feedback').textContent = 'Connecte-toi pour télécharger l’e-mail avec les pièces jointes.'; return; } try { const response = await request('/' + encodeURIComponent(dialogItem.id) + '/email.eml', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: $('mail-to').value, subject: $('mail-subject').value, body: $('mail-body').value, attachmentKinds: [...selectedKinds] }) }); if (!response.ok) throw new Error('Brouillon indisponible.'); if (response.headers.get('X-Tracker-Attachment-Kinds') !== JSON.stringify([...selectedKinds])) throw new Error('Le serveur doit ?tre actualis? pour respecter les pi?ces retir?es.'); downloadBlob(await response.blob(), 'Bewerbung-' + dialogItem.id + '.eml'); $('dialog-feedback').textContent = 'Brouillon téléchargé avec ton texte et les pièces disponibles. Vérifie-le dans ton application mail avant l’envoi.'; } catch (error) { $('dialog-feedback').textContent = error.message; } });
  $('share-files').addEventListener('click', async () => { try { await navigator.share({ title: $('mail-subject').value, text: 'An: ' + $('mail-to').value + '\nBetreff: ' + $('mail-subject').value + '\n\n' + $('mail-body').value, files: sharedFiles }); } catch (error) { if (error.name !== 'AbortError') $('dialog-feedback').textContent = 'Partage indisponible. Télécharge les PDF puis joins-les à ton e-mail.'; } });
  $('export').addEventListener('click', () => { downloadBlob(new Blob([JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), applications, outbox }, null, 2)], { type: 'application/json;charset=utf-8' }), 'SUIVI_CANDIDATURES-' + today() + '.json'); });
  $('import').addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file) return;
    try { const text = await file.text(); const parsed = text.trim().startsWith('<') ? JSON.parse(new DOMParser().parseFromString(text, 'text/html').querySelector('#applications-data').textContent) : JSON.parse(text); const records = Array.isArray(parsed) ? parsed : parsed.applications;
      if (Array.isArray(records)) { for (const record of records) if (validDate(record.sentAt) || record.status === 'applied' && record.sentAt === null) legacy[record.id] = { status: 'applied', sentAt: record.sentAt }; }
      else if (records && typeof records === 'object') { for (const [id, record] of Object.entries(records)) if (validDate(record.sentAt)) legacy[id] = { sentAt: record.sentAt }; }
      else throw new Error('Format de sauvegarde inconnu.');
      for (const app of applications) if (legacy[app.id] && !app.revision) Object.assign(app, { status: 'applied', sentAt: legacy[app.id].sentAt }); persist(); render(); await synchronize(); notify('Statuts de la sauvegarde récupérés ; les changements plus récents du serveur restent prioritaires.');
    } catch (error) { notify('Import impossible : ' + error.message); } event.target.value = '';
  });
  window.addEventListener('online', synchronize);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && auth) synchronize(); });
  setInterval(() => { if (!document.hidden && auth) synchronize(); }, 60000);
  overlayOutbox(); render(); if (!initial.length && !auth) $('login-form').hidden = false; if (auth) synchronize();
})();
