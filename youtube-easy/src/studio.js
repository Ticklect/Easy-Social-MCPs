import path from "node:path";
import { parseGoogleYoutubeUrl } from "./validation.js";

export const STUDIO_SELECTORS = Object.freeze({
  videoInput: 'input[type="file"][accept*="video"]',
  fallbackUploadInput: 'ytcp-uploads-file-picker input[type="file"], input[type="file"]',
  thumbnailInput: 'input[type="file"][accept*="image"]',
  title: '#title-textarea #textbox, ytcp-social-suggestion-input #textbox[contenteditable="true"]',
  description: '#description-textarea #textbox, ytcp-social-suggestion-input #textbox[contenteditable="true"]',
  next: '#next-button',
  final: '#done-button, #save-button, ytcp-button#done-button, ytcp-button#save-button',
  editSave: '#save, #save-button, ytcp-button#save',
});

function portableBasename(value) {
  const text = String(value || "");
  return text.includes("\\") ? path.win32.basename(text) : path.posix.basename(text);
}

function normalizedTags(value) {
  if (!Array.isArray(value)) return value;
  return value.map((tag) => String(tag).trim()).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function sameTags(a, b) {
  const left = normalizedTags(a);
  const right = normalizedTags(b);
  return Array.isArray(left) && Array.isArray(right) && JSON.stringify(left) === JSON.stringify(right);
}

function verificationError(mismatches) {
  const error = new Error(`Verification failed; final YouTube Studio action was not clicked: ${mismatches.join("; ")}`);
  error.finalActionNotSent = true;
  return error;
}

function compareRequested(expected, actual, keys) {
  const mismatches = [];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(expected, key) || expected[key] === undefined) continue;
    if (key === "tags") {
      if (!sameTags(expected.tags, actual.tags)) mismatches.push("tags did not match or could not be re-read");
      continue;
    }
    if (actual[key] === undefined || actual[key] === null) {
      mismatches.push(`${key} could not be re-read`);
    } else if (actual[key] !== expected[key]) {
      mismatches.push(`${key} did not match`);
    }
  }
  return mismatches;
}

export function verifyUploadState(expected, actual) {
  if (!expected || !actual || typeof expected !== "object" || typeof actual !== "object") {
    throw verificationError(["Studio state was unavailable"]);
  }
  const mismatches = [];
  if (actual.fileName !== portableBasename(expected.filePath)) mismatches.push("selected filename did not match");
  if (Number(actual.fileSize) !== Number(expected.fileSize)) mismatches.push("selected file size did not match");
  if (actual.title !== expected.title) mismatches.push("title did not match");
  if (actual.description !== (expected.description ?? "")) mismatches.push("description did not match");
  if (actual.madeForKids !== expected.madeForKids) mismatches.push("audience did not match or could not be re-read");

  if (expected.publishAt) {
    if (actual.visibility !== "scheduled") mismatches.push("scheduled visibility was not selected");
    if (!actual.publishAt || Date.parse(actual.publishAt) !== Date.parse(expected.publishAt)) mismatches.push("scheduled publication instant did not match");
    if (typeof actual.scheduleTimeZone !== "string" || !actual.scheduleTimeZone.trim()) mismatches.push("schedule time zone could not be re-read");
  } else if (actual.visibility !== expected.visibility) {
    mismatches.push("visibility did not match or could not be re-read");
  }

  if (expected.thumbnailPath && actual.thumbnailFileName !== portableBasename(expected.thumbnailPath)) mismatches.push("thumbnail did not match or could not be re-read");
  if (expected.playlist !== undefined && actual.playlist !== expected.playlist) mismatches.push("playlist did not match or could not be re-read");
  if (expected.tags?.length && !sameTags(expected.tags, actual.tags)) mismatches.push("tags did not match or could not be re-read");

  if (mismatches.length) throw verificationError(mismatches);
  return actual;
}

export function verifyEditState(expected, actual) {
  if (!expected || !actual || typeof expected !== "object" || typeof actual !== "object") {
    throw verificationError(["Studio edit state was unavailable"]);
  }
  const mismatches = compareRequested(expected, actual, ["title", "description", "madeForKids", "visibility", "playlist", "tags", "publishAt", "thumbnailFileName"]);
  if (expected.publishAt !== undefined) {
    if (!actual.publishAt || Date.parse(actual.publishAt) !== Date.parse(expected.publishAt)) mismatches.push("publishAt instant did not match");
    if (typeof actual.scheduleTimeZone !== "string" || !actual.scheduleTimeZone.trim()) mismatches.push("schedule time zone could not be re-read");
  }
  if (mismatches.length) throw verificationError([...new Set(mismatches)]);
  return actual;
}

export async function commitOnlyAfterVerification({ readState, expected, verify = verifyUploadState, commit }) {
  if (typeof readState !== "function" || typeof commit !== "function" || typeof verify !== "function") {
    throw new Error("readState, verify, and commit functions are required.");
  }
  let verified;
  try {
    const actual = await readState();
    verified = verify(expected, actual);
  } catch (error) {
    error.finalActionNotSent = true;
    throw error;
  }
  const committed = await commit(verified);
  return committed && typeof committed === "object" ? { ...verified, ...committed } : verified;
}

function validVideoId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) throw new Error("Invalid YouTube video ID.");
  return id;
}

function validChannelId(value) {
  const id = String(value || "").trim();
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(id)) throw new Error("Invalid YouTube channel ID.");
  return id;
}

export class StudioAdapter {
  constructor({ client, browser, sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    if (!client?.evaluate) throw new Error("StudioAdapter requires a connected CDP client.");
    this.client = client;
    this.browser = browser;
    this.sleep = sleepFn;
    this.capturedVideo = null;
    this.stopCapture = null;
  }

  async goto(url) {
    const safe = parseGoogleYoutubeUrl(url).href;
    if (this.browser?.navigate) return await this.browser.navigate(this.client, safe);
    if (!this.client.send) throw new Error("This Studio adapter cannot navigate without a browser or CDP Page client.");
    await this.client.send("Page.navigate", { url: safe });
    for (let i = 0; i < 80; i++) {
      const state = await this.client.evaluate("({ready:document.readyState,href:location.href})").catch(() => null);
      if (state && ["interactive", "complete"].includes(state.ready)) {
        parseGoogleYoutubeUrl(state.href);
        return state.href;
      }
      await this.sleep(250);
    }
    throw new Error("Timed out loading YouTube Studio.");
  }

  async waitFor(expression, label, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.client.evaluate(expression).catch(() => null);
      if (result) return result;
      await this.sleep(250);
    }
    throw new Error(`Timed out waiting for ${label}.`);
  }

  async getStatus() {
    return await this.client.evaluate(String.raw`(() => { /* __youtubeEasyStatus */
      const href = location.href;
      const body = (document.body?.innerText || '').slice(0, 5000);
      const channelLink = Array.from(document.querySelectorAll('a[href*="/channel/UC"]')).map(a => a.href).find(Boolean) || '';
      const match = channelLink.match(/\/channel\/(UC[A-Za-z0-9_-]{22})(?:[/?#]|$)/);
      const configured = globalThis.ytcfg?.get?.('CHANNEL_ID');
      const channelId = (typeof configured === 'string' && /^UC[A-Za-z0-9_-]{22}$/.test(configured)) ? configured : (match?.[1] || null);
      const nameNode = document.querySelector('#channel-name, #entity-name, ytcp-channel-name, [data-testid="channel-name"]');
      const channelName = (nameNode?.textContent || '').trim().slice(0, 200) || null;
      const loginPage = /accounts\.google\.com/.test(location.hostname) || /sign in/i.test(document.title) || /Sign in to YouTube/i.test(body);
      return { loggedIn: Boolean(channelId) && !loginPage, channelId, channelName, href };
    })()`);
  }

  async requireChannel() {
    const status = await this.getStatus();
    if (!status?.loggedIn || !status.channelId) throw new Error("Not logged into a verified YouTube channel. Run youtube_login and finish signing in in the dedicated browser.");
    return status;
  }

  async clickSemantic(labels, selectors = []) {
    const result = await this.client.evaluate(String.raw`(() => { /* __youtubeEasyClickSemantic */
      const labels = ${JSON.stringify(labels)}.map(x => x.toLowerCase());
      const selectors = ${JSON.stringify(selectors)};
      const visible = el => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none'; };
      const candidates = [];
      for (const selector of selectors) for (const el of document.querySelectorAll(selector)) if (visible(el)) candidates.push(el);
      for (const el of document.querySelectorAll('button, [role="button"], ytcp-button, tp-yt-paper-item')) {
        const text = (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase();
        if (visible(el) && labels.some(label => text === label || text.includes(label))) candidates.push(el);
      }
      const unique = [...new Set(candidates)].filter(el => !el.disabled && el.getAttribute('aria-disabled') !== 'true');
      if (unique.length !== 1) return { clicked:false, count:unique.length };
      unique[0].click();
      return { clicked:true, label:(unique[0].getAttribute('aria-label') || unique[0].textContent || '').trim().slice(0,200) };
    })()`);
    if (!result?.clicked) throw new Error(`Studio control was ambiguous or unavailable (${result?.count ?? 0} matches).`);
    return result;
  }

  async openUploadDialog(channelId) {
    const channel = channelId ? validChannelId(channelId) : null;
    const url = channel ? `https://studio.youtube.com/channel/${channel}/videos/upload` : "https://studio.youtube.com/";
    await this.goto(url);
    if (!channel) {
      await this.clickSemantic(["create"], ["#create-icon"]);
      await this.clickSemantic(["upload videos", "upload video"], ["#text-item-0"]);
    }
    await this.waitFor(`Boolean(document.querySelector(${JSON.stringify(STUDIO_SELECTORS.fallbackUploadInput)}))`, "the Studio video file input");
  }

  startVideoIdCapture(onVideoId) {
    if (!this.client.on || !this.client.send) return () => {};
    const stop = this.client.on("Network.responseReceived", async ({ response, requestId }) => {
      try {
        const responseUrl = parseGoogleYoutubeUrl(response?.url);
        const host = responseUrl.hostname.toLowerCase();
        if (!(host === "youtube.com" || host.endsWith(".youtube.com")) || !responseUrl.pathname.includes("/upload/createvideo")) return;
        const body = await this.client.send("Network.getResponseBody", { requestId });
        const parsed = JSON.parse(body?.body || "{}");
        const videoId = validVideoId(parsed.videoId || parsed.encryptedVideoId || parsed?.video?.videoId);
        this.capturedVideo = {
          videoId: String(videoId),
          studioUrl: `https://studio.youtube.com/video/${videoId}/edit`,
          publicUrl: `https://youtu.be/${videoId}`,
        };
        await onVideoId?.(this.capturedVideo);
      } catch {}
    });
    this.stopCapture = stop;
    return stop;
  }

  async selectVideoFile(filePath, onVideoId) {
    this.startVideoIdCapture(onVideoId);
    try {
      await this.client.setFileInputFiles(STUDIO_SELECTORS.videoInput, [filePath]);
    } catch (firstError) {
      try { await this.client.setFileInputFiles(STUDIO_SELECTORS.fallbackUploadInput, [filePath]); }
      catch { throw new Error(`Studio video file input was unavailable or ambiguous: ${firstError.message}`); }
    }
    await this.waitFor(`Boolean(document.querySelector(${JSON.stringify(STUDIO_SELECTORS.title)}))`, "the Studio upload details dialog", 30_000);
  }

  async readSelectedMediaMetadata() {
    return await this.client.evaluate(String.raw`(async () => { /* __youtubeEasyReadMediaMetadata */
      const inputs = Array.from(document.querySelectorAll('input[type="file"]')).filter(input => input.files?.length && (input.accept || '').toLowerCase().includes('video'));
      const fallback = Array.from(document.querySelectorAll('input[type="file"]')).filter(input => input.files?.length && !(input.accept || '').toLowerCase().includes('image'));
      const input = inputs.length === 1 ? inputs[0] : (fallback.length === 1 ? fallback[0] : null);
      if (!input?.files?.[0]) throw new Error('Selected video file could not be re-read.');
      const file = input.files[0];
      const objectUrl = URL.createObjectURL(file);
      try {
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.src = objectUrl;
        await new Promise((resolve, reject) => {
          video.onloadedmetadata = resolve;
          video.onerror = () => reject(new Error('Video metadata could not be decoded.'));
          setTimeout(() => reject(new Error('Video metadata timed out.')), 15000);
        });
        return { fileName:file.name, fileSize:file.size, duration:video.duration, width:video.videoWidth, height:video.videoHeight };
      } finally { URL.revokeObjectURL(objectUrl); }
    })()`);
  }

  async fillUploadDetails(intent) {
    const result = await this.client.evaluate(String.raw`(() => { /* __youtubeEasyFillUploadDetails */
      const intent = ${JSON.stringify(intent)};
      const visible = el => { if(!el) return false; const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden'; };
      const fire = el => { el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:null})); el.dispatchEvent(new Event('change',{bubbles:true})); };
      const setText = (el, value) => { if(!el) return false; el.focus(); if(el.isContentEditable){ el.textContent=value; } else { const proto=Object.getPrototypeOf(el); const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set; setter ? setter.call(el,value) : (el.value=value); } fire(el); return true; };
      const unique = selector => { const matches=Array.from(document.querySelectorAll(selector)).filter(visible); return matches.length===1?matches[0]:null; };
      const title = unique(${JSON.stringify(STUDIO_SELECTORS.title)});
      const description = unique(${JSON.stringify(STUDIO_SELECTORS.description)});
      const titleSet = setText(title,intent.title);
      const descriptionSet = setText(description,intent.description || '');
      const audienceName = intent.madeForKids ? 'VIDEO_MADE_FOR_KIDS_MFK' : 'VIDEO_MADE_FOR_KIDS_NOT_MFK';
      const audience = unique('[name="'+audienceName+'"]');
      if(audience && audience.getAttribute('aria-checked')!=='true') audience.click();
      return { titleSet, descriptionSet, audienceSet:Boolean(audience), audienceName };
    })()`);
    if (!result?.titleSet || !result?.descriptionSet || !result?.audienceSet) {
      throw new Error("Studio did not expose an unambiguous title, description, and audience control; upload remains a draft/private item.");
    }

    if (intent.thumbnailPath) {
      try { await this.client.setFileInputFiles(STUDIO_SELECTORS.thumbnailInput, [intent.thumbnailPath]); }
      catch { throw new Error("Studio did not expose one unambiguous thumbnail file input; upload remains a draft/private item."); }
    }
    if (intent.playlist !== undefined) await this.selectPlaylist(intent.playlist);
    if (intent.tags?.length) await this.setTags(intent.tags);
  }

  async selectPlaylist(playlist) {
    await this.clickSemantic(["playlist", "select playlist"], ["#playlist"]);
    const result = await this.client.evaluate(String.raw`(() => { /* __youtubeEasySelectPlaylist */
      const wanted=${JSON.stringify(playlist)};
      const visible=el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0};
      const labels=Array.from(document.querySelectorAll('ytcp-checkbox-lit, tp-yt-paper-checkbox, [role="option"], [role="menuitemcheckbox"]')).filter(visible);
      const matches=labels.filter(el=>(el.textContent||'').trim()===wanted);
      if(matches.length!==1) return {selected:false,count:matches.length};
      if(matches[0].getAttribute('aria-checked')!=='true' && !matches[0].hasAttribute('checked')) matches[0].click();
      const done=Array.from(document.querySelectorAll('button,ytcp-button,[role="button"]')).filter(visible).filter(el=>/^(done|save)$/i.test((el.textContent||el.getAttribute('aria-label')||'').trim()));
      if(done.length!==1) return {selected:false,count:done.length};
      done[0].click(); return {selected:true};
    })()`);
    if (!result?.selected) throw new Error("Requested playlist could not be selected and verified unambiguously.");
  }

  async setTags(tags) {
    await this.clickSemantic(["show more", "more options"], ["#toggle-button"]);
    const result = await this.client.evaluate(String.raw`(() => { /* __youtubeEasySetTags */
      const tags=${JSON.stringify(tags)};
      const candidates=Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"]')).filter(el=>/tag/i.test(el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.id||''));
      if(candidates.length!==1) return {set:false,count:candidates.length};
      const el=candidates[0], value=tags.join(', '); el.focus();
      if(el.isContentEditable) el.textContent=value; else { const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value')?.set; setter?setter.call(el,value):(el.value=value); }
      el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'})); el.dispatchEvent(new Event('change',{bubbles:true}));
      return {set:true};
    })()`);
    if (!result?.set) throw new Error("Studio did not expose one unambiguous tags control; upload remains a draft/private item.");
  }

  async advanceToVisibility() {
    for (let step = 0; step < 3; step++) {
      const atVisibility = await this.client.evaluate(String.raw`Boolean(document.querySelector('[name="PRIVATE"], [name="UNLISTED"], [name="PUBLIC"], [name="SCHEDULE"]'))`);
      if (atVisibility) return;
      await this.clickSemantic(["next"], [STUDIO_SELECTORS.next]);
      await this.sleep(300);
    }
    const atVisibility = await this.client.evaluate(String.raw`Boolean(document.querySelector('[name="PRIVATE"], [name="UNLISTED"], [name="PUBLIC"], [name="SCHEDULE"]'))`);
    if (!atVisibility) throw new Error("Studio upload steps changed before visibility; upload remains a draft/private item.");
  }

  async setUploadVisibility(intent) {
    const result = await this.client.evaluate(String.raw`(() => { /* __youtubeEasySetVisibility */
      const intent=${JSON.stringify(intent)};
      const name=intent.publishAt?'SCHEDULE':String(intent.visibility||'').toUpperCase();
      const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};
      const radios=Array.from(document.querySelectorAll('[name="'+name+'"]')).filter(visible);
      const radio=radios.length===1?radios[0]:null;
      if(!radio) return {set:false,reason:'radio'};
      if(radio.getAttribute('aria-checked')!=='true') radio.click();
      if(!intent.publishAt) return {set:true};
      const date=new Date(intent.publishAt); if(!Number.isFinite(date.getTime())) return {set:false,reason:'date'};
      const inputs=Array.from(document.querySelectorAll('input')).filter(visible);
      const dates=inputs.filter(el=>/date/.test((el.getAttribute('aria-label')||el.placeholder||'').toLowerCase()));
      const times=inputs.filter(el=>/time/.test((el.getAttribute('aria-label')||el.placeholder||'').toLowerCase()));
      if(dates.length!==1||times.length!==1) return {set:false,reason:'schedule-inputs'};
      const dateInput=dates[0],timeInput=times[0];
      const local=new Date(intent.publishAt);
      const dateValue=new Intl.DateTimeFormat(undefined,{year:'numeric',month:'2-digit',day:'2-digit'}).format(local);
      const timeValue=new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit',hour12:false}).format(local);
      const set=(el,value)=>{el.focus();const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value')?.set;setter?setter.call(el,value):(el.value=value);el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));el.dispatchEvent(new Event('change',{bubbles:true}));};
      set(dateInput,dateValue); set(timeInput,timeValue);
      return {set:true,dateValue,timeValue};
    })()`);
    if (!result?.set) throw new Error(`Studio could not set the requested visibility/schedule unambiguously (${result?.reason || "unknown"}); upload remains a draft/private item.`);
  }

  async readUploadState() {
    const state = await this.client.evaluate(String.raw`(() => { /* __youtubeEasyReadUploadState */
      const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};
      const videoInputs=Array.from(document.querySelectorAll('input[type="file"]')).filter(input=>input.files?.length && !(input.accept||'').toLowerCase().includes('image'));
      const imageInputs=Array.from(document.querySelectorAll('input[type="file"]')).filter(input=>input.files?.length && (input.accept||'').toLowerCase().includes('image'));
      const unique=selector=>{const matches=Array.from(document.querySelectorAll(selector)).filter(visible);return matches.length===1?matches[0]:null};
      const title=unique(${JSON.stringify(STUDIO_SELECTORS.title)});
      const description=unique(${JSON.stringify(STUDIO_SELECTORS.description)});
      const text=el=>el ? String(el.value ?? el.textContent ?? '') : null;
      const selected=name=>{const matches=Array.from(document.querySelectorAll('[name="'+name+'"]')).filter(visible);return matches.length===1&&(matches[0].getAttribute('aria-checked')==='true'||matches[0].checked)?matches[0]:null};
      let madeForKids=null;
      if(selected('VIDEO_MADE_FOR_KIDS_MFK')) madeForKids=true;
      else if(selected('VIDEO_MADE_FOR_KIDS_NOT_MFK')) madeForKids=false;
      let visibility=null;
      for(const name of ['PRIVATE','UNLISTED','PUBLIC','SCHEDULE']) if(selected(name)) visibility=visibility?null:(name==='SCHEDULE'?'scheduled':name.toLowerCase());
      const scheduleInputs=Array.from(document.querySelectorAll('input')).filter(visible);
      const dateInputs=scheduleInputs.filter(el=>/date/.test((el.getAttribute('aria-label')||el.placeholder||'').toLowerCase()));
      const timeInputs=scheduleInputs.filter(el=>/time/.test((el.getAttribute('aria-label')||el.placeholder||'').toLowerCase()));
      const scheduleText=dateInputs.length===1&&timeInputs.length===1?dateInputs[0].value+' '+timeInputs[0].value:'';
      const tzNode=Array.from(document.querySelectorAll('*')).filter(visible).find(el=>/\b(?:GMT|UTC)[+-]?\d{0,2}(?::\d{2})?\b/i.test((el.textContent||'').trim()) && el.children.length===0);
      const playlistChecked=Array.from(document.querySelectorAll('[role="menuitemcheckbox"][aria-checked="true"],tp-yt-paper-checkbox[checked],ytcp-checkbox-lit[checked]')).map(el=>(el.textContent||'').trim()).filter(Boolean);
      const tagControl=Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"]')).find(el=>/tag/i.test(el.getAttribute('aria-label')||el.placeholder||el.id||''));
      const tags=text(tagControl)?.split(',').map(x=>x.trim()).filter(Boolean) ?? null;
      const links=Array.from(document.querySelectorAll('a[href*="youtu.be/"],a[href*="youtube.com/watch"],a[href*="/video/"]')).map(a=>a.href);
      const candidate=links.join(' '); const idMatch=candidate.match(/(?:youtu\.be\/|[?&]v=|\/video\/)([A-Za-z0-9_-]{6,20})/);
      const videoId=idMatch?.[1]||null;
      return {
        fileName:videoInputs.length===1?videoInputs[0].files[0].name:null,
        fileSize:videoInputs.length===1?videoInputs[0].files[0].size:null,
        title:text(title), description:text(description), madeForKids, visibility,
        publishAt:visibility==='scheduled' && scheduleText ? new Date(scheduleText).toISOString() : null,
        scheduleTimeZone:tzNode?(tzNode.textContent||'').trim():null,
        thumbnailFileName:imageInputs.length===1?imageInputs[0].files[0].name:null,
        playlist:playlistChecked.length===1?playlistChecked[0]:null,
        tags, videoId,
        studioUrl:videoId?'https://studio.youtube.com/video/'+videoId+'/edit':null,
        publicUrl:videoId?'https://youtu.be/'+videoId:null
      };
    })()`);
    return { ...state, ...(this.capturedVideo || {}) };
  }

  async commitUpload(expected) {
    return await commitOnlyAfterVerification({
      readState: () => this.readUploadState(),
      expected,
      verify: verifyUploadState,
      commit: async () => {
        const result = await this.client.evaluate(String.raw`(() => { /* __youtubeEasyClickFinalUpload */
          const visible=el=>{const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};
          const labels=${JSON.stringify(expected.publishAt ? ["schedule"] : expected.visibility === "public" ? ["publish", "save"] : ["save", "done"])};
          const nodes=Array.from(document.querySelectorAll(${JSON.stringify(STUDIO_SELECTORS.final)}+',button,[role="button"]')).filter(visible).filter(el=>labels.some(label=>(el.getAttribute('aria-label')||el.textContent||'').trim().toLowerCase()===label));
          const unique=[...new Set(nodes)].filter(el=>!el.disabled&&el.getAttribute('aria-disabled')!=='true');
          if(unique.length!==1) return {clicked:false,count:unique.length}; unique[0].click(); return {clicked:true,label:(unique[0].textContent||unique[0].getAttribute('aria-label')||'').trim()};
        })()`);
        if (!result?.clicked) throw new Error(`Final Studio upload control was ambiguous (${result?.count ?? 0} matches); no click was sent.`);
        return this.capturedVideo || {};
      },
    });
  }

  async openVideo(videoId) {
    const id = validVideoId(videoId);
    await this.goto(`https://studio.youtube.com/video/${id}/edit`);
    for (let attempt = 0; attempt < 80; attempt++) {
      const presence = await this.client.evaluate(String.raw`(() => { /* __youtubeEasyVideoPresence */
        const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};
        const titles=Array.from(document.querySelectorAll(${JSON.stringify(STUDIO_SELECTORS.title)})).filter(visible);
        if(titles.length===1)return {status:'exists'};
        const errors=Array.from(document.querySelectorAll('ytcp-error-message,[role="alert"],#error-message,.error-message')).filter(visible).map(el=>String(el.textContent||'').trim());
        if(errors.length===1&&/^(?:video (?:not found|unavailable)|(?:this )?video does(?: not|n't) exist)[.!]?$/i.test(errors[0]))return {status:'absent'};
        return {status:'unknown'};
      })()`);
      if (presence?.status === "exists") return id;
      if (presence?.status === "absent") {
        const error = new Error("YouTube Studio explicitly reported that the video does not exist.");
        error.code = "VIDEO_NOT_FOUND";
        throw error;
      }
      await this.sleep(250);
    }
    throw new Error("Timed out waiting for an unambiguous YouTube Studio video details or not-found state.");
  }

  async applyEdit(expected) {
    const result = await this.client.evaluate(String.raw`(() => { /* __youtubeEasyApplyEdit */
      const expected=${JSON.stringify(expected)};
      const fire=el=>{el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));el.dispatchEvent(new Event('change',{bubbles:true}))};
      const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};
      const one=selector=>{const matches=Array.from(document.querySelectorAll(selector)).filter(visible);return matches.length===1?matches[0]:null};
      const set=(selector,value)=>{const el=one(selector);if(!el)return false;el.focus();if(el.isContentEditable)el.textContent=value;else{const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value')?.set;setter?setter.call(el,value):(el.value=value)}fire(el);return true};
      const applied={};
      if(expected.title!==undefined) applied.title=set(${JSON.stringify(STUDIO_SELECTORS.title)},expected.title);
      if(expected.description!==undefined) applied.description=set(${JSON.stringify(STUDIO_SELECTORS.description)},expected.description);
      if(expected.madeForKids!==undefined){const name=expected.madeForKids?'VIDEO_MADE_FOR_KIDS_MFK':'VIDEO_MADE_FOR_KIDS_NOT_MFK';const el=one('[name="'+name+'"]');if(el&&el.getAttribute('aria-checked')!=='true')el.click();applied.madeForKids=Boolean(el)}
      if(expected.visibility!==undefined){const el=one('[name="'+String(expected.visibility).toUpperCase()+'"]');if(el&&el.getAttribute('aria-checked')!=='true')el.click();applied.visibility=Boolean(el)}
      return applied;
    })()`);
    for (const key of ["title", "description", "madeForKids", "visibility"]) {
      if (expected[key] !== undefined && !result?.[key]) throw new Error(`Studio does not expose a supported unambiguous ${key} control; no save was clicked.`);
    }
    if (expected.playlist !== undefined) await this.selectPlaylist(expected.playlist);
    if (expected.tags?.length) await this.setTags(expected.tags);
  }

  async readEditState() {
    return await this.client.evaluate(String.raw`(() => { /* __youtubeEasyReadEditState */
      const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};
      const one=selector=>{const matches=Array.from(document.querySelectorAll(selector)).filter(visible);return matches.length===1?matches[0]:null};
      const text=selector=>{const el=one(selector);return el?String(el.value??el.textContent??''):null};
      const selected=name=>{const el=one('[name="'+name+'"]');return el&&(el.getAttribute('aria-checked')==='true'||el.checked)?el:null};
      let madeForKids=null;if(selected('VIDEO_MADE_FOR_KIDS_MFK'))madeForKids=true;else if(selected('VIDEO_MADE_FOR_KIDS_NOT_MFK'))madeForKids=false;
      let visibility=null;for(const name of ['PRIVATE','UNLISTED','PUBLIC','SCHEDULE'])if(selected(name))visibility=visibility?null:(name==='SCHEDULE'?'scheduled':name.toLowerCase());
      const playlists=Array.from(document.querySelectorAll('[role="menuitemcheckbox"][aria-checked="true"],tp-yt-paper-checkbox[checked],ytcp-checkbox-lit[checked]')).map(el=>(el.textContent||'').trim()).filter(Boolean);
      const tag=Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"]')).find(el=>/tag/i.test(el.getAttribute('aria-label')||el.placeholder||el.id||''));
      const images=Array.from(document.querySelectorAll('input[type="file"][accept*="image"]')).filter(input=>input.files?.length);
      const scheduleInputs=Array.from(document.querySelectorAll('input')).filter(visible);
      const dateInputs=scheduleInputs.filter(el=>/date/.test((el.getAttribute('aria-label')||el.placeholder||'').toLowerCase()));
      const timeInputs=scheduleInputs.filter(el=>/time/.test((el.getAttribute('aria-label')||el.placeholder||'').toLowerCase()));
      const scheduleText=dateInputs.length===1&&timeInputs.length===1?dateInputs[0].value+' '+timeInputs[0].value:'';
      const parsedSchedule=scheduleText?new Date(scheduleText):null;
      const tzNode=Array.from(document.querySelectorAll('*')).find(el=>el.children.length===0&&/\b(?:GMT|UTC)[+-]?\d{0,2}(?::\d{2})?\b/i.test((el.textContent||'').trim()));
      return {title:text(${JSON.stringify(STUDIO_SELECTORS.title)}),description:text(${JSON.stringify(STUDIO_SELECTORS.description)}),madeForKids,visibility,playlist:playlists.length===1?playlists[0]:null,tags:tag?String(tag.value??tag.textContent??'').split(',').map(x=>x.trim()).filter(Boolean):null,thumbnailFileName:images.length===1?images[0].files[0].name:null,publishAt:parsedSchedule&&Number.isFinite(parsedSchedule.getTime())?parsedSchedule.toISOString():null,scheduleTimeZone:tzNode?(tzNode.textContent||'').trim():null};
    })()`);
  }

  async commitEdit(expected) {
    return await commitOnlyAfterVerification({
      readState: () => this.readEditState(),
      expected,
      verify: verifyEditState,
      commit: async () => await this.clickSemantic(["save"], [STUDIO_SELECTORS.editSave]),
    });
  }

  async commitThumbnail(expected) {
    return await this.commitEdit({ thumbnailFileName: expected.thumbnailFileName });
  }

  async commitSchedule(expected) {
    return await this.commitEdit({ visibility: "scheduled", publishAt: expected.publishAt });
  }

  async setThumbnailFile(filePath) {
    try { await this.client.setFileInputFiles(STUDIO_SELECTORS.thumbnailInput, [filePath]); }
    catch { throw new Error("Studio did not expose one unambiguous thumbnail file input; no save was clicked."); }
  }

  async setSchedule(publishAt) {
    await this.setUploadVisibility({ visibility: "public", publishAt });
  }

  async listContent({ limit = 25 } = {}) {
    await this.goto("https://studio.youtube.com/");
    return await this.client.evaluate(String.raw`(() => { /* __youtubeEasyListContent */
      const limit=${Math.max(1, Math.min(50, Number(limit) || 25))};
      const rows=Array.from(document.querySelectorAll('ytcp-video-row, ytcp-content-item, [role="row"]'));
      const clean=value=>String(value||'').trim().replace(/\s+/g,' ').slice(0,5000);
      return rows.slice(0,limit).map(row=>{
        const link=Array.from(row.querySelectorAll('a[href]')).map(a=>a.href).find(h=>/\/video\/[A-Za-z0-9_-]+\/edit|[?&]v=/.test(h||''))||'';
        const match=link.match(/(?:\/video\/|[?&]v=)([A-Za-z0-9_-]{6,20})/);
        const status=clean(row.querySelector('[class*="status"], [aria-label*="visibility" i]')?.textContent);
        const lower=status.toLowerCase();let visibility=null;for(const value of ['scheduled','private','unlisted','public'])if(lower.includes(value))visibility=visibility?null:value;
        const dateNode=row.querySelector('time[datetime],[datetime]');const parsed=Date.parse(dateNode?.getAttribute('datetime')||'');
        return {videoId:match?.[1]||null,title:clean(row.querySelector('#video-title, [aria-label*="title" i], a')?.textContent),status,visibility,createdAt:Number.isFinite(parsed)?new Date(parsed).toISOString():null,studioUrl:match?'https://studio.youtube.com/video/'+match[1]+'/edit':null,publicUrl:match?'https://youtu.be/'+match[1]:null};
      }).filter(item=>item.videoId&&item.title);
    })()`);
  }

  async readVideo(videoId) {
    await this.openVideo(videoId);
    const state = await this.readEditState();
    const processing = await this.client.evaluate(String.raw`(() => { /* __youtubeEasyReadProcessingState */
      const clean=value=>String(value||'').trim().replace(/\s+/g,' ').slice(0,500);
      const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};
      const leaves=Array.from(document.querySelectorAll('ytcp-video-upload-progress,ytcp-video-checks-status,[class*="progress" i],[class*="check" i],[aria-label*="processing" i],[aria-label*="checks" i]')).filter(visible);
      const values=leaves.map(el=>clean(el.getAttribute('aria-label')||el.textContent)).filter(Boolean);
      const upload=values.filter(value=>/upload|process|draft|complete|failed/i.test(value));
      const checks=values.filter(value=>/check|copyright|restriction/i.test(value));
      return {uploadStatus:upload.length===1?upload[0]:null,checksStatus:checks.length===1?checks[0]:null};
    })()`);
    return { videoId, ...state, ...processing, studioUrl: `https://studio.youtube.com/video/${videoId}/edit`, publicUrl: `https://youtu.be/${videoId}` };
  }

  async deleteVideo(videoId, confirmTitle) {
    await this.openVideo(videoId);
    const state = await this.readEditState();
    if (state.title !== confirmTitle) throw new Error("Current Studio title did not exactly match confirm_title; nothing was deleted.");
    await this.clickSemantic(["options", "more actions", "more"], ["#overflow-menu"]);
    await this.clickSemantic(["delete forever", "delete video"]);
    const prepared = await this.client.evaluate(String.raw`(() => { /* __youtubeEasyPrepareDelete */
      const dialog=Array.from(document.querySelectorAll('[role="dialog"],ytcp-dialog')).filter(el=>el.getBoundingClientRect().width>0);
      if(dialog.length!==1)return {ready:false,reason:'dialog'};const d=dialog[0];
      const text=(d.textContent||'').trim();if(!text.toLowerCase().includes(${JSON.stringify(confirmTitle.toLowerCase())}))return {ready:false,reason:'title'};
      const checks=Array.from(d.querySelectorAll('tp-yt-paper-checkbox,input[type="checkbox"],[role="checkbox"]'));if(checks.length!==1)return {ready:false,reason:'checkbox'};
      if(checks[0].getAttribute('aria-checked')!=='true'&&!checks[0].checked)checks[0].click();return {ready:true};
    })()`);
    if (!prepared?.ready) throw new Error(`Delete confirmation was ambiguous (${prepared?.reason || "unknown"}); nothing was deleted.`);
    await this.clickSemantic(["delete forever", "delete"]);
    for (let attempt = 0; attempt < 20; attempt++) {
      const presence = await this.client.evaluate(String.raw`(() => { /* __youtubeEasyConfirmDelete */
        const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};
        const title=Array.from(document.querySelectorAll(${JSON.stringify(STUDIO_SELECTORS.title)})).filter(visible);
        if(title.length===1)return {status:'exists'};
        const errors=Array.from(document.querySelectorAll('ytcp-error-message,[role="alert"],#error-message,.error-message')).filter(visible).map(el=>String(el.textContent||'').trim());
        if(errors.length===1&&/^(?:video (?:not found|unavailable)|(?:this )?video does(?: not|n't) exist)[.!]?$/i.test(errors[0]))return {status:'absent'};
        return {status:'unknown'};
      })()`);
      if (presence?.status === "absent") return { message: "Deletion confirmed absent in YouTube Studio.", videoId };
      await this.sleep(250);
    }
    throw new Error("Delete was clicked, but Studio did not confirm that the video is absent.");
  }

  async listComments({ videoId, limit = 50 } = {}) {
    const suffix = videoId ? `?filter=VIDEO&videoId=${encodeURIComponent(validVideoId(videoId))}` : "";
    await this.goto(`https://studio.youtube.com/comments/inbox${suffix}`);
    return await this.client.evaluate(String.raw`(() => { /* __youtubeEasyListComments */
      const limit=${Math.max(1, Math.min(100, Number(limit) || 50))};const clean=(v,n=10000)=>String(v||'').trim().replace(/\s+/g,' ').slice(0,n);
      const rows=Array.from(document.querySelectorAll('ytcp-comment-thread, ytcp-comment, [data-comment-id]'));
      return rows.slice(0,limit).map(row=>({commentId:row.getAttribute('data-comment-id')||row.querySelector('[data-comment-id]')?.getAttribute('data-comment-id')||row.id||null,author:clean(row.querySelector('#author-text,[class*="author"]')?.textContent,500),text:clean(row.querySelector('#content-text,[class*="comment-text"],yt-formatted-string')?.textContent),videoTitle:clean(row.querySelector('[class*="video-title"]')?.textContent,500),published:clean(row.querySelector('time,[class*="published"]')?.textContent,200)})).filter(item=>item.commentId&&item.text);
    })()`);
  }

  async replyToComment(commentId, text, { channelId } = {}) {
    const result = await this.client.evaluate(String.raw`(() => { /* __youtubeEasyReplyComment */
      const id=${JSON.stringify(String(commentId))},text=${JSON.stringify(String(text))};
      const rows=Array.from(document.querySelectorAll('ytcp-comment-thread,ytcp-comment,[data-comment-id]')).filter(row=>(row.getAttribute('data-comment-id')||row.querySelector('[data-comment-id]')?.getAttribute('data-comment-id')||row.id)===id);
      if(rows.length!==1)return {sent:false,reason:'comment',count:rows.length};const row=rows[0];
      const reply=Array.from(row.querySelectorAll('button,[role="button"],ytcp-button')).filter(el=>/reply/i.test(el.getAttribute('aria-label')||el.textContent||''));if(reply.length!==1)return {sent:false,reason:'reply-button',count:reply.length};reply[0].click();
      const box=Array.from(row.querySelectorAll('textarea,input,[contenteditable="true"]')).filter(el=>el.getBoundingClientRect().width>0);if(box.length!==1)return {sent:false,reason:'textbox',count:box.length};const el=box[0];el.focus();if(el.isContentEditable)el.textContent=text;else{const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value')?.set;setter?setter.call(el,text):(el.value=text)}el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));
      const send=Array.from(row.querySelectorAll('button,[role="button"],ytcp-button')).filter(el=>/^(reply|send)$/i.test((el.getAttribute('aria-label')||el.textContent||'').trim())&&!el.disabled);if(send.length!==1)return {sent:false,reason:'send-button',count:send.length};send[0].click();return {sent:true};
    })()`);
    if (!result?.sent) throw new Error(`Studio comment reply controls were ambiguous (${result?.reason || "unknown"}); no reply was sent.`);
    for (let attempt = 0; attempt < 20; attempt++) {
      const found = await this.findReply(commentId, text, { channelId });
      if (found?.status === "found") return { message: "Reply confirmed in YouTube Studio.", commentId };
      await this.sleep(250);
    }
    throw new Error("Reply was clicked, but Studio did not confirm the exact reply under the signed-in channel.");
  }

  async findReply(commentId, text, { channelId } = {}) {
    return await this.client.evaluate(String.raw`(() => { /* __youtubeEasyFindReply */
      const id=${JSON.stringify(String(commentId))},wanted=${JSON.stringify(String(text))},channelId=${JSON.stringify(String(channelId || ""))};
      const clean=value=>String(value||'').trim().replace(/\s+/g,' ');
      const rows=Array.from(document.querySelectorAll('ytcp-comment-thread,ytcp-comment,[data-comment-id]')).filter(row=>(row.getAttribute('data-comment-id')||row.querySelector('[data-comment-id]')?.getAttribute('data-comment-id')||row.id)===id);
      if(rows.length!==1)return {status:'unknown'};
      const replyNodes=Array.from(rows[0].querySelectorAll('[class*="reply"],ytcp-comment'));
      if(!channelId)return {status:'unknown'};
      const matches=replyNodes.filter(node=>{const links=Array.from(node.querySelectorAll('a[href*="/channel/"]')).map(link=>(link.href.match(/\/channel\/(UC[A-Za-z0-9_-]{22})(?:[/?#]|$)/)||[])[1]).filter(Boolean);const texts=Array.from(node.querySelectorAll('#content-text,[class*="comment-text"],yt-formatted-string')).map(el=>clean(el.textContent));return links.length===1&&links[0]===channelId&&texts.length===1&&texts[0]===clean(wanted)});
      return matches.length===1?{status:'found',result:{message:'Found exact existing Studio reply',commentId:id}}:matches.length===0?{status:'not_found'}:{status:'unknown'};
    })()`);
  }

  async findVideoByIntent(intent) {
    const rows = await this.listContent({ limit: 50 });
    const titleMatches = rows.filter((row) => row.title === intent.title);
    // Studio does not expose the local file fingerprint, and the first page is not an
    // exhaustive history. Title/time/visibility can narrow investigation but cannot
    // prove identity or absence, so fallback reconciliation must remain uncertain.
    void intent.fileFingerprint;
    void titleMatches;
    return { status: "unknown" };
  }
}
