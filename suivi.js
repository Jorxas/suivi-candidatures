'use strict';
(() => {
  const localPage = typeof location !== 'undefined' && (location.protocol === 'file:' || ['localhost', '127.0.0.1'].includes(location.hostname));
  const API = localPage ? 'http://127.0.0.1:5517/api/tracker' : 'https://pos-job-assistant.onrender.com/api/tracker';
  const CACHE = 'jordan-tracker-cache-v2', OUTBOX = 'jordan-tracker-outbox-v2', AUTH = 'jordan-tracker-session-v2';
  const $ = id => document.getElementById(id);
  const initial = JSON.parse($('applications-data').textContent || '[]');
  const dateFormat = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const read = (store, key, fallback) => { try { return JSON.parse(store.getItem(key)) || fallback; } catch { return fallback; } };
  const VIEW = 'jordan-tracker-hide-applied-v1';
  let hideApplied = read(localStorage, VIEW, false) === true;
  let applications = initial.map(a => ({ ...a, status: a.status || (a.sentAt ? 'applied' : 'pending'), revision: a.revision || 0 }));
  const cached = read(localStorage, CACHE, { applications: [] });
  applications = [...new Map([...applications, ...(Array.isArray(cached.applications) ? cached.applications : [])].map(a => [a.id, a])).values()];
  let outbox = read(localStorage, OUTBOX, {}), auth = read(sessionStorage, AUTH, ''), online = false, busy = false, dialogItem = null, sharedFiles = [], feedbackTimer;
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
  function notify(text) { clearTimeout(feedbackTimer); $('feedback').textContent = text; $('feedback').hidden = false; feedbackTimer = setTimeout(() => { $('feedback').hidden = true; }, 5500); }
  function persist() {
    try { localStorage.setItem(CACHE, JSON.stringify({ version: 2, applications })); localStorage.setItem(OUTBOX, JSON.stringify(outbox)); }
    catch { notify('Le navigateur refuse le stockage local. Télécharge une sauvegarde ; les changements reçus par le serveur restent enregistrés.'); }
  }
  function syncLabel(message) {
    const count = Object.keys(outbox).length;
    $('sync-status').textContent = message || (online ? count ? count + ' changement(s) en attente de synchronisation.' : 'Synchronisé · sauvegardé sur le serveur.' : count ? count + ' changement(s) conservé(s) sur cet appareil. Connecte-toi pour les synchroniser.' : initial.length ? 'Mode local · connecte-toi pour retrouver ton suivi sur téléphone.' : 'Connecte-toi pour charger tes entreprises, tes statuts et tes documents.');
    $('connect').textContent = auth ? 'Déconnexion' : 'Se connecter';
  }
  const labels = { cv: 'CV (PDF)', letter: 'Anschreiben (PDF)', bundle: 'Dossier complet (PDF)', transcript: 'Leistungsübersicht (PDF)', enrollment: 'Studienbescheinigung (PDF)' };
  function documents(app) {
    if (Array.isArray(app.documents)) return app.documents;
    const docs = [];
    if (app.folder) {
      if (app.cv !== false) docs.push({ kind: 'cv', filename: app.cvFile || 'Lebenslauf.pdf' });
      if (app.letter !== false) docs.push({ kind: 'letter', filename: app.letterFile || 'Anschreiben.pdf' });
      if (app.bundle) docs.push({ kind: 'bundle', filename: app.bundle });
      if (app.transcript) docs.push({ kind: 'transcript', filename: 'Leistungsuebersicht.pdf' });
    }
    return docs;
  }
  function docButtons(app) {
    const box = node('div', 'links');
    for (const d of documents(app)) box.append(button(d.kind === 'cv' && d.isGeneral ? 'CV général (PDF)' : labels[d.kind] || d.kind, 'document:' + d.kind, app.id));
    return box;
  }
  function card(app) {
    const article = node('article', 'card'); article.dataset.id = app.id;
    const info = node('div'); const title = node('h3', '', app.company); title.id = 'title-' + app.id; article.setAttribute('aria-labelledby', title.id); info.append(title, node('p', 'role', app.role));
    if (app.location) info.append(node('p', 'meta', app.location));
    const badge = app.opportunityType === 'open-role' ? 'Offre publiée' : app.opportunityType === 'initiative' ? 'Candidature spontanée' : app.historical ? 'Ancien dossier' : 'Dossier existant';
    info.append(node('span', 'badge' + (app.historical ? ' historical' : ''), badge));
    if (app.status === 'applied') info.append(node('p', 'meta', app.sentAt ? 'Postulée le ' + dateFormat.format(new Date(app.sentAt + 'T12:00:00')) : 'Déjà postulée · date non renseignée'));
    if (app.status === 'unknown') info.append(node('p', 'meta', 'Envoi à confirmer'));
    if (app.status === 'archived') info.append(node('p', 'meta', 'Archivée · conservée dans le suivi'));
    if (app.note) info.append(node('p', 'note', app.note));
    if (app.addedAt || app.verifiedAt) info.append(node('p', 'meta', 'Ajout / vérification : ' + (app.verifiedAt || app.addedAt)));
    const docs = docButtons(app); if (docs.childElementCount) info.append(docs);
    if (!documents(app).some(d => d.kind === 'letter')) info.append(node('p', 'meta', 'Lettre adaptée à préparer. CV général disponible après connexion.'));
    const sources = node('div', 'links'); if (app.email) sources.append(link(app.email, 'mailto:' + app.email));
    if (app.url) sources.append(link(app.opportunityType === 'initiative' ? 'Site / carrière ↗' : 'Annonce / formulaire ↗', app.url));
    if (app.sourceUrl) sources.append(link(app.sourceLabel || 'Source', app.sourceUrl));
    if (Array.isArray(app.sourceUrls)) app.sourceUrls.slice(0, 2).filter(u => u !== app.url).forEach((u, i) => sources.append(link('Source officielle ' + (i + 1), u)));
    if (sources.childElementCount) info.append(sources);
    const actions = node('div', 'actions'); actions.append(button('Postuler / e-mail', 'prepare', app.id));
    if (app.status === 'applied') actions.append(button('Remettre à postuler', 'state:pending', app.id, 'undo'));
    else { actions.append(button(app.status === 'unknown' ? 'J’ai déjà postulé' : '✓ J’ai postulé', 'state:applied', app.id, 'primary')); if (app.status === 'unknown' || app.status === 'archived') actions.append(button('À postuler', 'state:pending', app.id)); }
    if (app.status !== 'archived') actions.append(button('Archiver', 'state:archived', app.id, 'undo'));
    if (outbox[app.id]) info.append(node('p', 'meta', 'Changement en attente de synchronisation.'));
    article.append(info, actions); return article;
  }
  function render() {
    $('sent-section').hidden = hideApplied;
    $('toggle-applied').textContent = hideApplied ? 'Afficher les postulées' : 'Masquer les postulées';
    $('toggle-applied').setAttribute('aria-expanded', String(!hideApplied));
    const q = normalize($('search').value), region = $('region').value, type = $('opportunity').value;
    const visible = applications.filter(a => (!q || normalize([a.company, a.role, a.location, a.sector].join(' ')).includes(q)) && (!region || a.region === region || region === 'Historique' && a.historical) && (!type || type === 'historical' ? !type || a.historical : a.opportunityType === type));
    const groups = { sent: visible.filter(a => a.status === 'applied'), pending: visible.filter(a => a.status !== 'applied') };
    groups.sent.sort((a, b) => (b.sentAt || '').localeCompare(a.sentAt || '') || a.company.localeCompare(b.company));
    groups.pending.sort((a, b) => (b.addedAt || b.verifiedAt || '').localeCompare(a.addedAt || a.verifiedAt || '') || a.company.localeCompare(b.company));
    for (const [name, list] of Object.entries(groups)) {
      $('' + name + '-list').replaceChildren(...list.map(card));
      if (!list.length) $(name + '-list').append(node('p', 'empty', applications.length ? 'Aucune candidature dans cette liste avec ces filtres.' : 'Connecte-toi pour charger tes entreprises et tes documents.'));
      $(name + '-count').textContent = list.length; $(name + '-total').textContent = applications.filter(a => name === 'sent' ? a.status === 'applied' : a.status !== 'applied').length;
    }
    $('overview').textContent = applications.length ? new Set(applications.map(a => normalize(a.company))).size + ' entreprises · ' + applications.length + ' fiches conservées' : 'Ton suivi apparaît après connexion.';
    if (!applications.length) for (const name of ['sent', 'pending']) { $(name + '-count').textContent = '—'; $(name + '-total').textContent = '—'; }
    syncLabel();
  }
  async function request(path = '', options = {}) {
    const headers = { ...(options.headers || {}) }; if (auth) headers.Authorization = auth;
    const response = await fetch(API + path, { ...options, headers, cache: 'no-store', signal: AbortSignal.timeout(90000) });
    if (response.status === 401) throw new Error('Connexion refusée. Vérifie ton identifiant et ton mot de passe.');
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
    finally { busy = false; }
  }
  async function changeState(app, status) {
    if (outbox[app.id] && busy) { notify('Cette fiche est en cours de sauvegarde.'); return; }
    const sentAt = status === 'applied' ? app.status === 'unknown' ? null : today() : null;
    outbox[app.id] = { status, sentAt, revision: outbox[app.id]?.revision ?? app.revision ?? 0 };
    Object.assign(app, { status, sentAt }); persist(); render();
    notify(online ? 'Enregistrement du statut…' : 'Statut conservé sur cet appareil ; connexion nécessaire pour le synchroniser.');
    await synchronize();
    if (online && !outbox[app.id]) notify('Statut enregistré sur le serveur.');
  }
  function downloadBlob(blob, filename) { const url = URL.createObjectURL(blob); const a = node('a'); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
  async function getDocument(app, kind) {
    const doc = documents(app).find(d => d.kind === kind); if (!doc) throw new Error('Ce document n’est pas encore préparé.');
    const response = await request('/' + encodeURIComponent(app.id) + '/documents/' + kind); if (!response.ok) throw new Error('Document indisponible. Connecte-toi ou actualise le suivi.');
    return new File([await response.blob()], doc.filename, { type: doc.contentType || 'application/pdf' });
  }
  async function downloadDocument(app, kind) {
    if (!auth && initial.length && app.folder) { const doc = documents(app).find(d => d.kind === kind); if (doc) { const a = node('a'); a.href = doc.isGeneral ? './Lebenslauf%20jordan.pdf' : '../' + encodeURIComponent(app.folder) + '/' + encodeURIComponent(doc.filename); a.download = doc.filename; document.body.append(a); a.click(); a.remove(); return; } }
    if (!auth) throw new Error('Connecte-toi pour télécharger les documents depuis ton téléphone.');
    const file = await getDocument(app, kind); downloadBlob(file, file.name);
  }
  function emailDraft(app) {
    return { subject: app.mailSubject || 'Initiativbewerbung als Werkstudent / Praktikant Softwareentwicklung / IT – Jordan Freddy', body: app.mailBody || 'Sehr geehrte Damen und Herren,\n\nich bewerbe mich initiativ bei ' + app.company + ' als Werkstudent oder Praktikant im Bereich Softwareentwicklung / IT. Ich studiere Bachelor Informatik an der Technischen Hochschule Mittelhessen in Gießen. In meinen Projekten arbeite ich mit Next.js, TypeScript, Java, REST-Schnittstellen und Datenbanken.\n\nIm Anhang finden Sie meinen Lebenslauf. Über eine Rückmeldung und ein Kennenlernen freue ich mich.\n\nMit freundlichen Grüßen\nJordan Freddy' };
  }
  async function openApplication(app) {
    dialogItem = app; sharedFiles = []; const draft = emailDraft(app); $('dialog-title').textContent = app.company; $('dialog-role').textContent = app.role; $('mail-to').value = app.email || ''; $('mail-subject').value = draft.subject; $('mail-body').value = draft.body; $('dialog-documents').replaceChildren(docButtons(app)); $('portal-action').replaceChildren();
    if (app.url) { const a = link(app.email ? 'Voir aussi le site / formulaire ↗' : 'Ouvrir le site / formulaire pour postuler ↗', app.url); a.className = 'button primary'; $('portal-action').append(a); }
    $('document-note').textContent = documents(app).some(d => d.kind === 'letter') ? 'Documents préparés dans ton dossier.' : 'CV général disponible ; lettre adaptée à préparer. Vérifie les pièces demandées avant l’envoi.';
    $('dialog-feedback').textContent = ''; $('share-files').disabled = true; $('application-dialog').showModal();
    if (auth) {
      const kinds = documents(app).some(d => d.kind === 'bundle') ? ['bundle'] : documents(app).filter(d => ['cv', 'letter'].includes(d.kind) || d.kind === 'transcript' && app.transcript || d.kind === 'enrollment' && app.enrollment).map(d => d.kind);
      try { const files = await Promise.all(kinds.map(kind => getDocument(app, kind))); if (dialogItem?.id !== app.id) return; sharedFiles = files; $('share-files').disabled = !files.length || !navigator.canShare || !navigator.canShare({ files }); }
      catch { $('dialog-feedback').textContent = 'Télécharge les pièces individuellement si le partage n’est pas disponible.'; }
    }
  }
  document.addEventListener('click', async event => {
    const b = event.target.closest('button[data-action]'); if (!b) return;
    const app = applications.find(a => a.id === b.dataset.id); if (!app) return;
    try { if (b.dataset.action === 'prepare') await openApplication(app); else if (b.dataset.action.startsWith('state:')) await changeState(app, b.dataset.action.split(':')[1]); else if (b.dataset.action.startsWith('document:')) await downloadDocument(app, b.dataset.action.split(':')[1]); }
    catch (error) { notify(error.message); }
  });
  for (const id of ['search', 'region', 'opportunity']) $(id).addEventListener('input', render);
  $('toggle-applied').addEventListener('click', () => {
    hideApplied = !hideApplied;
    try { localStorage.setItem(VIEW, JSON.stringify(hideApplied)); } catch {}
    render();
  });
  $('connect').addEventListener('click', () => { if (auth) { auth = ''; online = false; sessionStorage.removeItem(AUTH); syncLabel(); } else { $('login-form').hidden = !$('login-form').hidden; if (!$('login-form').hidden) $('password').focus(); } });
  $('login-form').addEventListener('submit', async event => { event.preventDefault(); auth = 'Basic ' + btoa(unescape(encodeURIComponent($('username').value + ':' + $('password').value))); try { sessionStorage.setItem(AUTH, JSON.stringify(auth)); } catch {} $('password').value = ''; await synchronize(); });
  $('refresh').addEventListener('click', () => { if (!auth) { $('login-form').hidden = false; $('password').focus(); } else synchronize(); });
  $('close-dialog').addEventListener('click', () => { $('application-dialog').close(); dialogItem = null; });
  $('copy-mail').addEventListener('click', async () => { try { await navigator.clipboard.writeText('An: ' + $('mail-to').value + '\nBetreff: ' + $('mail-subject').value + '\n\n' + $('mail-body').value); $('dialog-feedback').textContent = 'E-mail copié.'; } catch { $('mail-body').select(); $('dialog-feedback').textContent = 'Sélectionne et copie le texte.'; } });
  $('open-mail').addEventListener('click', () => { if (!$('mail-to').value || !$('mail-to').checkValidity()) { $('mail-to').focus(); $('dialog-feedback').textContent = 'Renseigne l’adresse du destinataire ou utilise le formulaire de l’entreprise.'; return; } location.href = 'mailto:' + encodeURIComponent($('mail-to').value) + '?subject=' + encodeURIComponent($('mail-subject').value) + '&body=' + encodeURIComponent($('mail-body').value); });
  $('download-eml').addEventListener('click', async () => { if (!auth) { $('dialog-feedback').textContent = 'Connecte-toi pour télécharger l’e-mail avec les pièces jointes.'; return; } try { const response = await request('/' + encodeURIComponent(dialogItem.id) + '/email.eml', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: $('mail-to').value, subject: $('mail-subject').value, body: $('mail-body').value }) }); if (!response.ok) throw new Error('Brouillon indisponible.'); downloadBlob(await response.blob(), 'Bewerbung-' + dialogItem.id + '.eml'); $('dialog-feedback').textContent = 'Brouillon téléchargé avec ton texte et les pièces disponibles. Vérifie-le dans ton application mail avant l’envoi.'; } catch (error) { $('dialog-feedback').textContent = error.message; } });
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
