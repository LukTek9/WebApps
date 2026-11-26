const options = {
  'text-diff': ['Lignes', 'Mots'],
  'duplicate-line-remover': ['Exact', 'Sensible à la casse', 'Sans casse', 'Trim + sans casse'],
  'lorem-ipsum': ['Texte', 'HTML <p>', 'HTML <ul>'],
  'base64-codec': ['Encoder texte', 'Décoder texte'],
  'text-reverser': ['Caractères', 'Mots', 'Lignes', 'Miroir'],
  'list-sorter': ['A → Z', 'Z → A', 'Numérique croissant', 'Numérique décroissant', 'Longueur', 'Aléatoire', 'Inverser'],
  'json-formatter': ['Indentation 2', 'Indentation 4', 'Minifier', 'Trier les clés'],
  'json-to-csv-xml': ['CSV', 'XML'],
  'url-html-codec': ['Encoder URL composant', 'Encoder URL complet', 'Décoder URL', 'Encoder entités HTML', 'Décoder entités HTML'],
  'regex-tester': ['Correspondances', 'Remplacer'],
  'css-js-minifier': ['CSS', 'JavaScript'],
  'code-formatter': ['SQL', 'HTML', 'XML'],
  'hash-generator': ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512', 'MD5'],
  'base-ascii-converter': ['Texte → Hex', 'Hex → Texte', 'Texte → Binaire', 'Binaire → Texte', 'Texte → Décimal'],
  'rsa-key-generator': ['RSA-OAEP 2048', 'RSA-OAEP 4096', 'ECDSA P-256'],
  'file-checksum': ['SHA-1', 'SHA-256', 'SHA-512'],
  'password-generator': ['Aléatoire', 'Prononçable'],
  'uuid-generator': ['Standard', 'Majuscules', 'Avec accolades', 'Sans tirets'],
  'barcode-generator': ['EAN-13', 'UPC-A', 'CODE128'],
  'stopwatch-timer': ['Chronomètre', 'Minuteur'],
  'date-diff-calculator': ['Différence', 'Ajouter des jours', 'Soustraire des jours'],
  'world-clock': ['Europe/Paris', 'America/New_York', 'Asia/Tokyo', 'Europe/London', 'Australia/Sydney'],
  'colorblind-simulator': ['Protanopie', 'Deutéranopie', 'Tritanopie', 'Achromatopsie'],
  'palette-generator': ['Complémentaire', 'Analogue', 'Triadique', 'Tétradique', 'Monochromatique'],
  'css-pattern-generator': ['Rayures', 'Points', 'Grille', 'Damier'],
  'svg-to-raster': ['PNG', 'WebP'],
  'list-deduplicator': ['Exact', 'Sans casse', 'Trim + sans casse'],
  'unit-converter': ['m → km', 'km → m', 'kg → lb', 'lb → kg', '°C → °F', '°F → °C'],
  'number-base-converter': ['Décimal', 'Binaire', 'Octal', 'Hexadécimal'],
  'html-validator': ['HTML'],
};
const resolveColorToken = (token) => {
  const probe=document.createElement('span');
  probe.style.color=`var(${token})`;
  document.body.appendChild(probe);
  const channels=getComputedStyle(probe).color.match(/[\d.]+/g);
  probe.remove();
  if(!channels||channels.length<3)throw new Error(`Impossible de résoudre le jeton ${token}.`);
  return `#${channels.slice(0,3).map(v=>Math.round(Number(v)).toString(16).padStart(2,'0')).join('')}`;
};

const fileTools = new Set([
  'base64-codec', 'qr-scanner', 'file-checksum', 'colorblind-simulator', 'svg-to-raster',
  'svg-optimizer', 'list-deduplicator', 'csv-viewer', 'exif-reader', 'file-splitter',
]);
const empty = (value) => String(value ?? '');
const esc = (value) => empty(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const bytesToHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const bytesToBase64 = (bytes) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
const base64ToBytes = (text) => Uint8Array.from(atob(text.replace(/\s/g, '')), (c) => c.charCodeAt(0));
const download = (blob, name, urls) => {
  const url = URL.createObjectURL(blob);
  urls.add(url);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 1000);
};
/** Copie : `navigator.clipboard.writeText` d'abord, repli <textarea> hors écran + `execCommand('copy')` (Safari, HTTP, file://). Rejette si échec. */
const copyText = async (text) => {
  const value = String(text ?? '');
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return; } catch { /* repli execCommand ci-dessous */ }
  }
  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
  document.body.append(field);
  let ok = false;
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange?.(0, value.length);
    ok = document.execCommand('copy');
  } catch { ok = false; } finally { field.remove(); }
  if (!ok) throw new Error('Copie impossible');
};
const sha = async (algo, data) => bytesToHex(new Uint8Array(await crypto.subtle.digest(algo, data)));
const normalize = (text) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const lines = (text) => text.split(/\r?\n/);
const words = (text) => text.trim().match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];
const randomInt = (max) => {
  if (!Number.isInteger(max) || max < 1 || max > 0x100000000) throw new Error('Valeur aléatoire invalide.');
  const limit = Math.floor(0x100000000 / max) * max;
  const words = new Uint32Array(1);
  do { crypto.getRandomValues(words); } while (words[0] >= limit);
  return words[0] % max;
};
const toHex = (text) => Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join(' ');
const fromHex = (hex) => new TextDecoder().decode(Uint8Array.from(hex.match(/[0-9a-f]{2}/gi) || [], (v) => parseInt(v, 16)));
const colorRgb = (hex) => {
  const clean = hex.trim().replace(/^#/, '');
  if (!/^(?:[\da-f]{3}|[\da-f]{6})$/i.test(clean)) throw new Error('Couleur HEX invalide.');
  const full = clean.length === 3 ? [...clean].map((c) => c + c).join('') : clean;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};
const rgbHex = ([r, g, b]) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const parseColorInput = (text, fallback) => {
  const value = text.trim();
  if (!value) return colorRgb(fallback);
  if (value.startsWith('#')) return colorRgb(value);
  const match = value.match(/^(rgb|hsl|hsv|cmyk)\s*\(([^)]+)\)$/i);
  if (!match) throw new Error('Utilisez HEX ou rgb(), hsl(), hsv(), cmyk().');
  const numbers = match[2].split(/[,\s/]+/).filter(Boolean).map((v) => parseFloat(v.replace('%', '')));
  if (numbers.length < 3 || numbers.some((v) => !Number.isFinite(v))) throw new Error('Valeurs de couleur incorrectes.');
  if (match[1].toLowerCase() === 'rgb') return numbers.slice(0, 3).map((v) => Math.max(0, Math.min(255, v)));
  if (match[1].toLowerCase() === 'hsl') return hslRgb(numbers[0], numbers[1], numbers[2]);
  if (match[1].toLowerCase() === 'cmyk') {
    if (numbers.length < 4) throw new Error('Le format CMYK requiert quatre valeurs.');
    const [c, m, y, k] = numbers.map((v) => v > 1 ? v / 100 : v);
    return [(1 - c) * (1 - k) * 255, (1 - m) * (1 - k) * 255, (1 - y) * (1 - k) * 255];
  }
  const [h, s, v] = [numbers[0], numbers[1] / 100, numbers[2] / 100];
  const f = (n) => { const k = (n + h / 60) % 6; return 255 * v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1))); };
  return [f(5), f(3), f(1)];
};
const rgbHsl = ([r, g, b]) => {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0; const l = (max + min) / 2;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
};
const hslRgb = (h, s, l) => {
  h = ((h % 360) + 360) % 360 / 360; s /= 100; l /= 100;
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
};
const csvParse = (text, delimiter) => {
  const sep = delimiter || ([',', ';', '\t'].sort((a, b) => text.split(b).length - text.split(a).length)[0]);
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted && c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (!quoted && c === sep) { row.push(cell); cell = ''; }
    else if (!quoted && c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if(id==='qr-scanner') {
    const camera=root.querySelector('[data-camera]'),video=root.querySelector('[data-video]');
    camera.addEventListener('click',async()=>{
      if(state.stream){state.stream.getTracks().forEach(track=>track.stop());state.stream=null;video.hidden=true;camera.textContent='Démarrer la caméra';cancelAnimationFrame(state.animationFrame);return;}
      try{
        state.stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});
        video.srcObject=state.stream;video.hidden=false;await video.play();camera.textContent='Arrêter la caméra';
        const detector='BarcodeDetector'in window?new BarcodeDetector({formats:['qr_code']}):null;
        if(!detector)await loadJsQr();
        const canvas=document.createElement('canvas'),ctx2=canvas.getContext('2d',{willReadFrequently:true});
        const scan=async()=>{
          if(!state?.stream)return;
          if(video.readyState>=2){
            let value='';
            if(detector){const found=await detector.detect(video);value=found[0]?.rawValue||'';}
            else{canvas.width=video.videoWidth;canvas.height=video.videoHeight;ctx2.drawImage(video,0,0);value=window.jsQR(ctx2.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height)?.data||'';}
            if(value){input.value=value;status.textContent='QR code détecté.';}
          }
          state.animationFrame=requestAnimationFrame(scan);
        };
        scan();
      }catch(err){state.stream?.getTracks().forEach(track=>track.stop());state.stream=null;status.className='status-error';status.textContent=err.message||'Accès à la caméra impossible.';}
    },{signal:abort.signal});
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  return rows;
};
const csvString = (rows, delimiter = ',') => rows.map((r) => r.map((v) => {
  const s = empty(v); return /["\r\n,;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(delimiter)).join('\n');
const safeJson = (text) => {
  try { return JSON.parse(text); }
  catch (error) {
    const position = Number(error.message.match(/position\s+(\d+)/i)?.[1] || 0);
    const before = text.slice(0, position);
    const line = before.split('\n').length;
    const column = position - before.lastIndexOf('\n');
    throw new Error(`JSON invalide ligne ${line}, colonne ${column} : ${error.message}`);
  }
};
const bytes = (size) => `${size < 1024 ? size + ' o' : size < 1048576 ? (size / 1024).toFixed(1) + ' Ko' : (size / 1048576).toFixed(2) + ' Mo'}`;

function md5(text) {
  const input = new TextEncoder().encode(text);
  const bitLength = input.length * 8;
  const padded = new Uint8Array(((input.length + 8) >> 6) + 1 ? (Math.ceil((input.length + 9) / 64) * 64) : 64);
  padded.set(input); padded[input.length] = 128;
  const view = new DataView(padded.buffer); view.setUint32(padded.length - 8, bitLength >>> 0, true); view.setUint32(padded.length - 4, Math.floor(bitLength / 4294967296), true);
  const shifts = [7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21];
  const k = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);
  let [a0,b0,c0,d0] = [0x67452301,0xefcdab89,0x98badcfe,0x10325476];
  for (let off=0; off<padded.length; off+=64) {
    const m = Array.from({length:16},(_,i)=>view.getUint32(off+i*4,true)); let [a,b,c,d]=[a0,b0,c0,d0];
    for(let i=0;i<64;i++){
      let f,g,sh;
      if(i<16){f=(b&c)|(~b&d);g=i;sh=shifts[i%4];}
      else if(i<32){f=(d&b)|(~d&c);g=(5*i+1)%16;sh=shifts[4+i%4];}
      else if(i<48){f=b^c^d;g=(3*i+5)%16;sh=shifts[8+i%4];}
      else{f=c^(b|~d);g=(7*i)%16;sh=shifts[12+i%4];}
      const n=(a+f+k[i]+m[g])>>>0; [a,d,c,b]=[d,c,b,(b+((n<<sh)|(n>>>(32-sh))))>>>0];
    }
    a0=(a0+a)>>>0;b0=(b0+b)>>>0;c0=(c0+c)>>>0;d0=(d0+d)>>>0;
  }
  return [a0,b0,c0,d0].map((n)=>[0,8,16,24].map((i)=>((n>>>i)&255).toString(16).padStart(2,'0')).join('')).join('');
}

function buildUI(id, name) {
  const hasFile = fileTools.has(id);
  const selects = options[id] || [];
  const firstLabel = id === 'text-diff' ? 'Texte de référence' : id.includes('calculator') || id === 'age-calculator' ? 'Valeur / date de départ' : 'Entrée';
  const secondLabel = id === 'text-diff' ? 'Texte à comparer' : id === 'regex-tester' ? 'Expression régulière' : 'Options / deuxième valeur';
  const hasSecond = ['text-diff','regex-tester','aes-encryptor','date-diff-calculator','rule-of-three','percentage-calculator','loan-calculator','file-checksum','file-splitter','wcag-contrast-checker'].includes(id);
  return `<section class="tool-panel" data-tool="${id}">
    <div class="tool-row"><span class="tool-badge">${esc(name)}</span><span class="status-muted">Les données sont traitées dans ce navigateur.</span></div>
    ${hasFile ? `<label class="tool-dropzone">Choisir un fichier local<input data-file type="file" hidden></label>` : ''}
    ${id === 'qr-scanner' ? '<div class="tool-row"><button class="btn-secondary" type="button" data-camera>Démarrer la caméra</button><video data-video playsinline hidden></video></div>' : ''}
    <div class="${hasSecond ? 'tool-split' : ''}">
      <label class="tool-field">${firstLabel}<textarea class="tool-textarea" data-input placeholder="${id.includes('json') ? '{"exemple": true}' : id==='color-converter' ? 'HEX, rgb(...), hsl(...), hsv(...) ou cmyk(...)' : 'Saisissez votre texte…'}"></textarea></label>
      ${hasSecond ? `<label class="tool-field">${secondLabel}<textarea class="tool-textarea" data-input2 placeholder="${id === 'text-diff' ? 'Collez le second texte…' : 'Valeur ou option…'}"></textarea></label>` : ''}
    </div>
    <div class="tool-row">
      ${selects.length ? `<label class="tool-field">Mode<select data-mode>${selects.map((v) => `<option>${esc(v)}</option>`).join('')}</select></label>` : ''}
      ${id === 'lorem-ipsum' ? '<label class="tool-field">Générer<select data-kind><option>Paragraphes</option><option>Phrases</option><option>Mots</option></select></label>' : ''}
      ${['password-generator','uuid-generator','random-generator','file-splitter','lorem-ipsum','stopwatch-timer','pomodoro-timer','typing-speed-test'].includes(id) ? `<label class="tool-field">Quantité / longueur<input data-number type="number" min="1" max="${id === 'uuid-generator' ? 500 : 1000}" value="${id === 'password-generator' ? 20 : id === 'uuid-generator' ? 5 : id === 'pomodoro-timer' ? 25 : 3}"></label>` : ''}
      ${['color-converter','wcag-contrast-checker','css-gradient-generator','css-shadow-generator','css-border-radius','palette-generator','css-pattern-generator'].includes(id) ? '<label class="tool-field">Couleur<input data-color type="color"></label>' : ''}
      ${id === 'wcag-contrast-checker' ? '<label class="tool-field">Arrière-plan<input data-color2 type="color"></label>' : ''}
      ${id === 'password-generator' ? `<label><input data-upper type="checkbox" checked> Majuscules</label><label><input data-lower type="checkbox" checked> Minuscules</label><label><input data-digits type="checkbox" checked> Chiffres</label><label><input data-symbols type="checkbox"> Symboles</label>` : ''}
      ${id === 'regex-tester' ? `<label class="tool-field">Remplacement<input data-replacement placeholder="Texte de remplacement"></label><label><input data-flag="i" type="checkbox"> i</label><label><input data-flag="m" type="checkbox"> m</label><label><input data-flag="s" type="checkbox"> s</label>` : ''}
      ${id === 'password-generator' || id === 'uuid-generator' ? `<label><input data-batch type="checkbox"> Plusieurs résultats</label>` : ''}
      ${id === 'secure-notepad' || id === 'kanban-board' ? `<label class="tool-field">Nom<input data-title placeholder="Titre"></label>` : ''}
      <button class="btn-primary" type="button" data-run>Exécuter</button>
      <button class="btn-secondary" type="button" data-copy>Copier le résultat</button>
      <button class="btn-secondary" type="button" data-download>Télécharger</button>
    </div>
    ${id === 'csv-viewer' ? '<label class="tool-field">Filtrer les lignes<input data-filter type="search" placeholder="Rechercher dans le tableau"></label>' : ''}
    <div data-status role="status" aria-live="polite"></div>
    <pre class="tool-code" data-output></pre>
    <div class="tool-preview-box" data-preview hidden></div>
  </section>`;
}

export function createToolModule(id) {
  let state = null;
  const unmount = () => {
    if (!state) return;
    state.abort.abort();
    clearInterval(state.interval);
    clearTimeout(state.liveTimer);
    cancelAnimationFrame(state.animationFrame);
    state.stream?.getTracks().forEach((track) => track.stop());
    state.urls.forEach(URL.revokeObjectURL);
    if (state.container) state.container.innerHTML = '';
    state = null;
  };
  const mount = (container, ctx) => {
    unmount();
    const abort = new AbortController();
    state = { abort, urls: new Set(), interval: null, stream: null, file: null, output: '', toolId: id, container };
    container.innerHTML = buildUI(id, ctx.tool.name);
    const root = container.querySelector(`[data-tool="${id}"]`);
    const input = root.querySelector('[data-input]');
    const input2 = root.querySelector('[data-input2]');
    const output = root.querySelector('[data-output]');
    const status = root.querySelector('[data-status]');
    const preview = root.querySelector('[data-preview]');
    const mode = root.querySelector('[data-mode]');
    const colorPicker = root.querySelector('[data-color]');
    if(colorPicker)colorPicker.value=resolveColorToken('--theme-accent');
    const color2=root.querySelector('[data-color2]');
    if(color2)color2.value=resolveColorToken('--color-surface');
    const num = root.querySelector('[data-number]');
    const readFile = async (file) => {
      state.file = file;
      status.textContent = `${file.name} · ${bytes(file.size)}`;
      if (id === 'base64-codec') input.value = `data:${file.type || 'application/octet-stream'};base64,${bytesToBase64(new Uint8Array(await file.arrayBuffer()))}`;
      else if (id === 'csv-viewer' || id === 'list-deduplicator' || id === 'svg-optimizer') input.value = await file.text();
      else if (id === 'file-checksum') input.value = file.name;
      else if (id === 'svg-to-raster') input.value = await file.text();
    };
    const perform = async () => {
      const text = input.value;
      const other = input2?.value || '';
      const selected = mode?.value || '';
      const count = Math.max(1, Math.min(Number(num?.value) || 1, id === 'uuid-generator' ? 500 : 1000));
      let result = '';
      let previewHtml = '';
      try {
        switch (id) {
          case 'word-counter': {
            const w = words(text), sentences = text.split(/[.!?]+/).filter((s) => s.trim()).length, paragraphs = text.trim() ? text.trim().split(/\n\s*\n/).length : 0;
            const freq = new Map(); w.forEach((v) => freq.set(v.toLocaleLowerCase('fr'), (freq.get(v.toLocaleLowerCase('fr')) || 0) + 1));
            const table = [...freq].sort((a,b)=>b[1]-a[1]).slice(0,20).map(([v,n])=>`<tr><td>${esc(v)}</td><td>${n}</td><td>${(n/Math.max(1,w.length)*100).toFixed(1)} %</td></tr>`).join('');
            previewHtml = `<div class="tool-stats-grid">${[['Mots',w.length],['Caractères',text.length],['Sans espaces',text.replace(/\s/g,'').length],['Phrases',sentences],['Paragraphes',paragraphs],['Lecture',`${Math.ceil(w.length/200)} min`],['Oral',`${Math.ceil(w.length/130)} min`]].map(([a,b])=>`<div class="tool-stat-card">${a}<br><strong>${b}</strong></div>`).join('')}</div><table class="tool-table"><thead><tr><th>Mot-clé</th><th>Nombre</th><th>Densité</th></tr></thead><tbody>${table}</tbody></table>`; result = `${w.length} mots · ${text.length} caractères`;
            break;
          }
          case 'text-diff': {
            const a = lines(text), b = lines(other), max = Math.max(a.length,b.length);
            result = Array.from({length:max},(_,i)=>a[i]===b[i]?`  ${a[i]||''}`:`- ${a[i]||''}\n+ ${b[i]||''}`).join('\n');
            previewHtml = `<pre>${Array.from({length:max},(_,i)=>a[i]===b[i]?`<span>${esc(a[i]||'')}</span>`:`<del>${esc(a[i]||'')}</del><br><ins>${esc(b[i]||'')}</ins>`).join('<br>')}</pre>`;
            if (selected === 'Mots') result = `− ${words(text).filter((w)=>!words(other).includes(w)).join(' ')}\n+ ${words(other).filter((w)=>!words(text).includes(w)).join(' ')}`;
            break;
          }
          case 'case-converter': {
            const parts = text.trim().split(/[\s_-]+/).filter(Boolean); const title = parts.map(w=>w.charAt(0).toLocaleUpperCase('fr')+w.slice(1).toLocaleLowerCase('fr'));
            result = [text.toLocaleUpperCase('fr'),text.toLocaleLowerCase('fr'),title.join(' '),text.replace(/(^\s*\p{L}|[.!?]\s*\p{L})/gu,m=>m.toLocaleUpperCase('fr')),parts.map((w,i)=>i?w.charAt(0).toUpperCase()+w.slice(1).toLowerCase():w.toLowerCase()).join(''),title.join(''),parts.map(w=>w.toLowerCase()).join('_'),parts.map(w=>w.toLowerCase()).join('-'),parts.map(w=>w.toUpperCase()).join('_')].join('\n');
            break;
          }
          case 'duplicate-line-remover': case 'list-deduplicator': {
            const trim = selected.includes('Trim') || selected === 'Sensible à la casse';
            const insensitive = selected.includes('Sans casse');
            const source = lines(text); const seen = new Set(); const out = source.filter((line)=>{const v=trim?line.trim():line;if(!v)return false;const key=insensitive?v.toLocaleLowerCase('fr'):v;if(seen.has(key))return false;seen.add(key);return true;});
            result = out.join('\n'); status.textContent = `${source.length-out.length} ligne(s) supprimée(s).`; break;
          }
          case 'text-cleaner': result = text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/<[^>]*>/g,'').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').replace(/[^\p{L}\p{N}\s]/gu,''); break;
          case 'lorem-ipsum': {
            const vocabulary='lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua'.split(' ');
            const makeSentence=(length,offset)=>`${Array.from({length},(_,i)=>vocabulary[(offset+i)%vocabulary.length]).join(' ')}.`;
            const kind=root.querySelector('[data-kind]').value;
            if(kind==='Mots')result=Array.from({length:count},(_,i)=>vocabulary[i%vocabulary.length]).join(' ');
            else if(kind==='Phrases')result=Array.from({length:count},(_,i)=>makeSentence(12,i*3)).join(' ');
            else result=Array.from({length:count},(_,i)=>Array.from({length:5},(_,j)=>makeSentence(12,i*5+j*3)).join(' ')).join('\n\n');
            if(selected==='HTML <p>')result=kind==='Paragraphes'?lines(result).map(p=>`<p>${p}</p>`).join('\n'):`<p>${result}</p>`;
            if(selected==='HTML <ul>')result=`<ul>${(kind==='Paragraphes'?lines(result):[result]).map(p=>`<li>${esc(p)}</li>`).join('')}</ul>`;
            break;
          }
          case 'markdown-to-html': {
            const html=esc(text).replace(/```([\s\S]*?)```/g,'<pre><code>$1</code></pre>').replace(/^### (.+)$/gm,'<h3>$1</h3>').replace(/^## (.+)$/gm,'<h2>$1</h2>').replace(/^# (.+)$/gm,'<h1>$1</h1>').replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>').replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,'<a href="$2">$1</a>').replace(/^> (.+)$/gm,'<blockquote>$1</blockquote>').replace(/^(?:- .+(?:\n|$))+?/gm,(m)=>`<ul>${m.trim().split('\n').map(l=>`<li>${l.slice(2)}</li>`).join('')}</ul>`).replace(/\n/g,'<br>');
            result=html; previewHtml=html; break;
          }
          case 'html-to-markdown': { const doc=new DOMParser().parseFromString(text,'text/html'); const convert=(node)=>[...node.childNodes].map(n=>{if(n.nodeType===3)return n.textContent;if(n.nodeType!==1)return'';const c=[...n.childNodes].map(convert).join('');switch(n.tagName){case'H1':return`# ${c}\n\n`;case'H2':return`## ${c}\n\n`;case'H3':return`### ${c}\n\n`;case'B':case'STRONG':return`**${c}**`;case'I':case'EM':return`*${c}*`;case'LI':return`- ${c}\n`;case'BR':return'\n';case'P':return`${c}\n\n`;case'A':return`[${c}](${n.getAttribute('href')||''})`;case'CODE':return`\`${c}\``;default:return c;}}).join(''); result=convert(doc.body).trim(); break; }
          case 'text-reverser': result=selected==='Mots'?words(text).reverse().join(' '):selected==='Lignes'?lines(text).reverse().join('\n'):selected==='Miroir'?text.replace(/[bqdp]/g,c=>({b:'d',d:'b',p:'q',q:'p'}[c])).split('').reverse().join(''):Array.from(text).reverse().join(''); break;
          case 'list-sorter': {const a=lines(text); result=(selected.includes('Z')?a.sort((x,y)=>y.localeCompare(x,'fr')):selected.includes('numérique')&&selected.includes('décroissant')?a.sort((x,y)=>Number(y)-Number(x)):selected.includes('numérique')?a.sort((x,y)=>Number(x)-Number(y)):selected==='Longueur'?a.sort((x,y)=>x.length-y.length):selected==='Aléatoire'?a.sort(()=>Math.random()-.5):selected==='Inverser'?a.reverse():a.sort((x,y)=>x.localeCompare(y,'fr'))).join('\n');break;}
          case 'json-formatter': case 'json-validator': {const obj=safeJson(text); if(selected.includes('Minifier'))result=JSON.stringify(obj);else if(selected.includes('Trier'))result=JSON.stringify(sortKeys(obj),null,2);else result=JSON.stringify(obj,null,selected.includes('4')?4:2);break;}
          case 'json-to-csv-xml': {const obj=safeJson(text);if(!Array.isArray(obj))throw new Error('Le JSON doit contenir un tableau.'); const rows=obj.map(v=>flatten(v));if(selected==='CSV')result=csvString([Object.keys(rows[0]||{}),...rows.map(r=>Object.values(r))]);else result=`<?xml version="1.0" encoding="UTF-8"?>\n<items>${rows.map(r=>`<item>${Object.entries(r).map(([k,v])=>`<${k.replace(/[^\w.-]/g,'_')}>${esc(v)}</${k.replace(/[^\w.-]/g,'_')}>`).join('')}</item>`).join('')}</items>`;break;}
          case 'csv-to-json': case 'csv-viewer': {const rows=csvParse(text);const headers=rows.shift()||[];const data=rows.map(r=>Object.fromEntries(headers.map((h,i)=>[h,cast(r[i]??'')])));result=JSON.stringify(data,null,2);if(id==='csv-viewer'){const stats=headers.map((h,i)=>{const nums=rows.map(r=>Number(r[i])).filter(Number.isFinite);return `${h}: ${nums.length?`min ${Math.min(...nums)}, max ${Math.max(...nums)}, moy ${(nums.reduce((a,b)=>a+b,0)/nums.length).toFixed(2)}`:'texte'}`;}).join(' · ');previewHtml=`<p>${rows.length} lignes · ${headers.length} colonnes · ${esc(stats)}</p><table class="tool-table"><thead><tr>${headers.map((h,i)=>`<th><button class="btn-secondary" type="button" data-sort="${i}">${esc(h)} ↕</button></th>`).join('')}</tr></thead><tbody>${rows.slice(0,200).map(r=>`<tr>${headers.map((_,i)=>`<td>${esc(r[i]||'')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;}break;}
          case 'base64-codec': {
            if(text.startsWith('data:')){
              const comma=text.indexOf(','),mime=text.slice(5,text.indexOf(';'))||'application/octet-stream',data=base64ToBytes(text.slice(comma+1));
              download(new Blob([data],{type:mime}),state.file?.name||'fichier-export',state.urls);result=`Fichier décodé · ${bytes(data.length)} · ${mime}`;
            }else if(selected==='Encoder texte')result=bytesToBase64(new TextEncoder().encode(text));
            else result=new TextDecoder().decode(base64ToBytes(text));
            break;
          }
          case 'url-html-codec': result=selected.includes('composant')?encodeURIComponent(text):selected.includes('complet')?encodeURI(text):selected==='Décoder URL'?decodeURIComponent(text):selected.includes('Encoder')?text.replace(/[&<>"']/g,c=>`&#${c.charCodeAt(0)};`):new DOMParser().parseFromString(text,'text/html').documentElement.textContent;break;
          case 'regex-tester': {const flags='g'+Array.from(root.querySelectorAll('[data-flag]:checked'),el=>el.dataset.flag).join('');const re=new RegExp(other,flags);if(selected==='Remplacer'){result=text.replace(re,root.querySelector('[data-replacement]').value);}else{const found=[...text.matchAll(re)];result=found.map(m=>`${m[0]}${m.length>1?` | groupes: ${m.slice(1).join(', ')}`:''}`).join('\n')||'Aucune correspondance';previewHtml=esc(text).replace(re,m=>`<mark>${esc(m)}</mark>`);}break;}
          case 'css-js-minifier': {result=selected==='CSS'?text.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\s+/g,' ').replace(/\s*([{}:;,])\s*/g,'$1').trim():text.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm,'$1').replace(/\s+/g,' ').replace(/\s*([=+\-*\/{}();,:])\s*/g,'$1').trim();status.textContent=`Réduction : ${text.length?Math.round((1-result.length/text.length)*100):0} %`;break;}
          case 'seo-meta-generator': result=`<title>${esc(text)}</title>\n<meta name="description" content="${esc(other)}">\n<meta property="og:title" content="${esc(text)}">\n<meta property="og:description" content="${esc(other)}">\n<meta name="twitter:card" content="summary_large_image">`;previewHtml=`<strong>${esc(text||'Titre de la page')}</strong><p>${esc(other||'Description de la page')}</p><span class="status-muted">example.com</span>`;break;
          case 'gitignore-env-generator': result=`# Node\nnode_modules/\ndist/\n.env\n# Python\n__pycache__/\n.venv/\n# macOS\n.DS_Store\n# Windows\nThumbs.db\n# VSCode\n.vscode/\n\n# Modèle .env\nAPI_KEY=\nDATABASE_URL=`;break;
          case 'code-formatter': case 'xml-formatter': {
            if(selected==='SQL'){
              const sql=text.replace(/\s+/g,' ').trim().replace(/\b(select|from|where|group by|order by|having|limit|insert into|values|update|set|delete from|left join|right join|inner join|join|on|and|or)\b/gi,'\n$1').trim();
              result=sql.split('\n').map((line,i)=>`${i>1&&/^(AND|OR)\b/i.test(line)?'  ':''}${line.replace(/\b(select|from|where|group by|order by|having|limit|insert into|values|update|set|delete from|left join|right join|inner join|join|on|and|or)\b/gi,m=>m.toUpperCase())}`).join('\n');
            }else{
              const pretty=text.replace(/>\s*</g,'>\n<').split('\n').map(l=>l.trim()).filter(Boolean);let depth=0;
              result=pretty.map(l=>{if(/^<\//.test(l))depth=Math.max(0,depth-1);const out='  '.repeat(depth)+l;if(/^<[^!?/][^>]*[^/]?>$/.test(l)&&!/<\/[^>]+>$/.test(l))depth++;return out;}).join('\n');
            }
            break;
          }
          case 'password-generator': {const pronounceable=['ba','be','bi','bo','bu','da','de','di','do','du','ka','ke','ki','ko','ku','la','le','li','lo','lu','ma','me','mi','mo','mu','na','ne','ni','no','nu','ra','re','ri','ro','ru','sa','se','si','so','su','ta','te','ti','to','tu'];if(selected==='Prononçable'){result=Array.from({length:root.querySelector('[data-batch]').checked?count:1},()=>Array.from({length:Math.max(4,Math.ceil(count/2))},()=>pronounceable[randomInt(pronounceable.length)]).join('')).join('\n');break;}const chars=(root.querySelector('[data-upper]').checked?'ABCDEFGHJKLMNPQRSTUVWXYZ':'')+(root.querySelector('[data-lower]').checked?'abcdefghijkmnopqrstuvwxyz':'')+(root.querySelector('[data-digits]').checked?'23456789':'')+(root.querySelector('[data-symbols]').checked?'!@#$%^&*()-_=+[]{}':'');if(!chars)throw new Error('Sélectionnez au moins un jeu de caractères.');result=Array.from({length:root.querySelector('[data-batch]').checked?count:1},()=>Array.from({length:Math.min(128,Math.max(8,count))},()=>chars[randomInt(chars.length)]).join('')).join('\n');break;}
          case 'hash-generator': result=selected==='MD5'?md5(text):await sha(selected,new TextEncoder().encode(text));break;
          case 'password-strength': {const pool=(/[a-z]/.test(text)?26:0)+(/[A-Z]/.test(text)?26:0)+(/\d/.test(text)?10:0)+(/[^a-zA-Z0-9]/.test(text)?32:0);const entropy=text.length*Math.log2(Math.max(pool,1));result=`Longueur : ${text.length}\nJeu estimé : ${pool} caractères\nEntropie estimée : ${entropy.toFixed(1)} bits\nTemps théorique à 10 milliards d’essais/s : ${Math.max(0,entropy-33).toFixed(1)} secondes\n${text.length<12?'Conseil : utilisez au moins 12 caractères uniques.':'Conseil : utilisez un gestionnaire et un mot de passe unique.'}`;break;}
          case 'uuid-generator': result=Array.from({length:root.querySelector('[data-batch]').checked?count:1},()=>{let value=crypto.randomUUID();if(selected==='Majuscules')value=value.toUpperCase();if(selected==='Avec accolades')value=`{${value}}`;if(selected==='Sans tirets')value=value.replace(/-/g,'');return value;}).join('\n');break;
          case 'aes-encryptor': {if(!other)throw new Error('Saisissez une phrase secrète dans le second champ.');if(text.startsWith('aes:')){const [_,salt64,iv64,cipher64]=text.split(':');const salt=base64ToBytes(salt64),iv=base64ToBytes(iv64);const key=await crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:250000,hash:'SHA-256'},await crypto.subtle.importKey('raw',new TextEncoder().encode(other),'PBKDF2',false,['deriveKey']),{name:'AES-GCM',length:256},false,['decrypt']);result=new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv},key,base64ToBytes(cipher64)));}else{const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));const key=await crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:250000,hash:'SHA-256'},await crypto.subtle.importKey('raw',new TextEncoder().encode(other),'PBKDF2',false,['deriveKey']),{name:'AES-GCM',length:256},false,['encrypt']);const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(text)));result=`aes:${bytesToBase64(salt)}:${bytesToBase64(iv)}:${bytesToBase64(cipher)}`;}break;}
          case 'jwt-decoder': {const parts=text.split('.');if(parts.length<2)throw new Error('JWT invalide.');const decode=(s)=>JSON.parse(new TextDecoder().decode(base64ToBytes(s.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(s.length/4)*4,'='))));const header=decode(parts[0]),payload=decode(parts[1]);for(const k of ['exp','iat'])if(payload[k])payload[`${k}_lisible`]=new Date(payload[k]*1000).toLocaleString('fr-FR');result=`En-tête\n${JSON.stringify(header,null,2)}\n\nCharge utile\n${JSON.stringify(payload,null,2)}\n\nSignature non vérifiée.`;break;}
          case 'base-ascii-converter': {
            if (selected.includes('Texte → Hex')) result = toHex(text);
            else if (selected.includes('Hex →')) result = fromHex(text);
            else if (selected.includes('Texte → Binaire')) result = Array.from(new TextEncoder().encode(text), (b) => b.toString(2).padStart(8, '0')).join(' ');
            else if (selected.includes('Binaire →')) result = new TextDecoder().decode(Uint8Array.from(text.match(/[01]{8}/g) || [], (b) => parseInt(b, 2)));
            else result = Array.from(new TextEncoder().encode(text)).join(' ');
            break;
          }
          case 'rsa-key-generator': {const isEc=selected.includes('ECDSA');const pair=await crypto.subtle.generateKey(isEc?{name:'ECDSA',namedCurve:'P-256'}:{name:'RSA-OAEP',modulusLength:selected.includes('4096')?4096:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,isEc?['sign','verify']:['encrypt','decrypt']);const pub=bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('spki',pair.publicKey)));const priv=bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8',pair.privateKey)));result=`-----BEGIN PUBLIC KEY-----\n${pub.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----\n\n-----BEGIN PRIVATE KEY-----\n${priv.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;break;}
          case 'file-checksum': if(!state.file)throw new Error('Choisissez un fichier.');result=await sha(selected,await state.file.arrayBuffer());if(other&&result.toLowerCase()===other.trim().toLowerCase())status.textContent='Empreinte identique.';break;
          case 'totp-generator': {const key=base32(text);const counter=Math.floor(Date.now()/30000);const mac=await crypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-1'},false,['sign']);const buf=new ArrayBuffer(8);new DataView(buf).setUint32(4,counter);const hash=new Uint8Array(await crypto.subtle.sign('HMAC',mac,buf));const off=hash[hash.length-1]&15;const n=((hash[off]&127)<<24)|(hash[off+1]<<16)|(hash[off+2]<<8)|hash[off+3];result=`${String(n%1000000).padStart(6,'0')} · expire dans ${30-Date.now()/1000%30|0}s`;break;}
          case 'qr-scanner': {
            if(!state.file)throw new Error('Choisissez une image QR.');
            if('BarcodeDetector'in window){const detector=new BarcodeDetector({formats:['qr_code']});const codes=await detector.detect(await createImageBitmap(state.file));result=codes.map(c=>c.rawValue).join('\n');}
            else{await loadJsQr();const image=await createImageBitmap(state.file),canvas=document.createElement('canvas'),ctx2=canvas.getContext('2d',{willReadFrequently:true});canvas.width=image.width;canvas.height=image.height;ctx2.drawImage(image,0,0);result=window.jsQR(ctx2.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height)?.data||'';image.close();}
            if(!result)result='Aucun QR code détecté.';break;
          }
          case 'barcode-generator': {const barcode=barcodeData(text,selected);result=barcode.text;previewHtml=`<svg viewBox="0 0 ${barcode.width} 100" role="img" aria-label="Code-barres">${barcode.markup}</svg>`;break;}
          case 'stopwatch-timer': case 'pomodoro-timer': result='Utilisez le bouton Démarrer pour lancer le chronomètre ou cycle.';break;
          case 'date-diff-calculator': {
            const a=new Date(text),b=new Date(other);
            if(Number.isNaN(+a))throw new Error('Date de départ invalide.');
            if(selected!=='Différence'){const d=new Date(a);d.setDate(d.getDate()+(selected.includes('Soustraire')?-1:1)*Number(other||count));result=d.toLocaleString('fr-FR');}
            else{
              if(Number.isNaN(+b))throw new Error('Saisissez une deuxième date valide.');
              let cursor=new Date(Math.min(+a,+b));const end=new Date(Math.max(+a,+b));let years=0,months=0;
              while(addCalendarMonths(cursor,12)<=end){cursor=addCalendarMonths(cursor,12);years++;}
              while(addCalendarMonths(cursor,1)<=end){cursor=addCalendarMonths(cursor,1);months++;}
              let remaining=end-cursor;const days=Math.floor(remaining/86400000);remaining%=86400000;const hours=Math.floor(remaining/3600000),minutes=Math.floor(remaining%3600000/60000);
              let business=0;for(let d=new Date(Math.min(+a,+b));d<=new Date(Math.max(+a,+b));d.setDate(d.getDate()+1))if(d.getDay()%6)business++;
              result=`${years} ans, ${months} mois, ${days} jours, ${hours} h ${minutes} min · ${business} jours ouvrés`;
            }
            break;
          }
          case 'world-clock': {const zone=selected||'Europe/Paris';result=`${new Intl.DateTimeFormat('fr-FR',{dateStyle:'full',timeStyle:'long',timeZone:zone}).format(new Date())}\nFuseau : ${zone}`;break;}
          case 'secure-notepad': {const key=`webapps-note-${root.querySelector('[data-title]')?.value||'note'}`;if(text)localStorage.setItem(key,text);result=localStorage.getItem(key)||'';break;}
          case 'kanban-board': {
            const key='webapps-kanban',board=JSON.parse(localStorage.getItem(key)||'[]');
            if(text.trim())board.push({id:crypto.randomUUID(),text:text.trim(),state:'À faire'});
            localStorage.setItem(key,JSON.stringify(board));
            const columns=['À faire','En cours','Terminé'];
            previewHtml=`<div class="tool-split">${columns.map((column,index)=>`<section class="tool-stat-card"><h3>${column}</h3>${board.filter(card=>card.state===column).map(card=>`<article class="tool-preview-box"><p>${esc(card.text)}</p><button class="btn-secondary" data-board-edit="${card.id}" type="button">Modifier</button><button class="btn-secondary" data-board-move="${card.id}" data-next="${columns[(index+1)%columns.length]}" type="button">Déplacer</button><button class="btn-remove-file" data-board-delete="${card.id}" type="button">Supprimer</button></article>`).join('')}</section>`).join('')}</div>`;
            result=`${board.length} tâche(s) enregistrée(s) localement.`;break;
          }
          case 'system-inspector': {
            const canvas=document.createElement('canvas'),gl=canvas.getContext('webgl')||canvas.getContext('experimental-webgl');
            const ext=gl?.getExtension('WEBGL_debug_renderer_info'),gpu=ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):'non communiqué';
            const battery=await navigator.getBattery?.().catch(()=>null),network=navigator.connection;
            result=`Écran : ${screen.width} × ${screen.height} · DPR ${devicePixelRatio}\nNavigateur : ${navigator.userAgent}\nCœurs CPU : ${navigator.hardwareConcurrency||'non communiqué'}\nMémoire : ${navigator.deviceMemory||'non communiquée'} Go\nGPU : ${gpu}\nBatterie : ${battery?`${Math.round(battery.level*100)} %${battery.charging?' · en charge':''}`:'non disponible'}\nRéseau : ${network?`${network.effectiveType||'inconnu'} · ${network.downlink||'?'} Mb/s`:'non communiqué'}\nLangue : ${navigator.language}\nConnexion : ${navigator.onLine?'en ligne':'hors ligne'}`;
            break;
          }
          case 'typing-speed-test': {const sample='Le navigateur permet de traiter vos fichiers localement et de préserver votre confidentialité.';const matched=[...text].filter((c,i)=>c===sample[i]).length;result=`Vitesse : ${(words(text).length*2).toFixed(0)} mots/min environ\nPrécision : ${text.length?Math.round(matched/text.length*100):0} %\nTexte de test : ${sample}`;break;}
          case 'color-converter': {const rgb=parseColorInput(text,colorPicker.value),hsl=rgbHsl(rgb);const max=Math.max(...rgb),min=Math.min(...rgb),delta=max-min;const hsvS=max?delta/max*100:0;const k=1-max/255;const c=k===1?0:(1-rgb[0]/255-k)/(1-k),m=k===1?0:(1-rgb[1]/255-k)/(1-k),y=k===1?0:(1-rgb[2]/255-k)/(1-k);result=`HEX ${rgbHex(rgb)}\nRGB ${rgb.join(', ')}\nHSL ${hsl.join(', ')}\nHSV ${hsl[0]}, ${hsvS.toFixed(0)} %, ${(max/255*100).toFixed(0)} %\nCMYK ${(c*100).toFixed(0)}, ${(m*100).toFixed(0)}, ${(y*100).toFixed(0)}, ${(k*100).toFixed(0)}`;previewHtml=`<div style="padding:2rem;background:${rgbHex(rgb)}">Aperçu de contraste</div>`;break;}
          case 'css-gradient-generator': result=`background: linear-gradient(90deg, ${colorPicker.value}, var(--color-primary));`;previewHtml=`<div style="height:10rem;background:linear-gradient(90deg,${colorPicker.value},var(--color-primary))"></div>`;break;
          case 'css-shadow-generator': result=`box-shadow: 0 8px 24px ${colorPicker.value}66;`;previewHtml=`<div style="padding:2rem;box-shadow:0 8px 24px ${colorPicker.value}66">Aperçu</div>`;break;
          case 'wcag-contrast-checker': {const a=colorRgb(colorPicker.value),b=colorRgb(root.querySelector('[data-color2]').value);const lum=(v)=>{const x=v/255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;};const l=(v)=>.2126*lum(v[0])+.7152*lum(v[1])+.0722*lum(v[2]);const ratio=(Math.max(l(a),l(b))+.05)/(Math.min(l(a),l(b))+.05);result=`Contraste : ${ratio.toFixed(2)}:1\nAA texte normal : ${ratio>=4.5?'Réussi':'Échec'}\nAAA texte normal : ${ratio>=7?'Réussi':'Échec'}\nAA grand texte : ${ratio>=3?'Réussi':'Échec'}\nAAA grand texte : ${ratio>=4.5?'Réussi':'Échec'}`;break;}
          case 'css-pattern-generator': {const bg=colorPicker.value;result=selected==='Rayures'?`background: repeating-linear-gradient(45deg, ${bg}, ${bg} 10px, var(--color-surface) 10px, var(--color-surface) 20px);`:selected==='Points'?`background: radial-gradient(${bg} 1px, transparent 1px); background-size: 16px 16px;`:selected==='Grille'?`background-image: linear-gradient(${bg} 1px, transparent 1px), linear-gradient(90deg, ${bg} 1px, transparent 1px); background-size: 20px 20px;`:`background-color: var(--color-surface); background-image: linear-gradient(45deg, ${bg} 25%, transparent 25%), linear-gradient(-45deg, ${bg} 25%, transparent 25%); background-size: 20px 20px;`;break;}
          case 'css-border-radius': result='border-radius: 35% 65% 70% 30% / 30% 40% 60% 70%;';previewHtml=`<div style="height:10rem;background:${colorPicker.value};border-radius:35% 65% 70% 30% / 30% 40% 60% 70%"></div>`;break;
          case 'colorblind-simulator': {
            if(!state.file)throw new Error('Choisissez une image à simuler.');
            const image=await createImageBitmap(state.file),canvas=document.createElement('canvas'),context=canvas.getContext('2d',{willReadFrequently:true});
            canvas.width=image.width;canvas.height=image.height;context.drawImage(image,0,0);
            const pixels=context.getImageData(0,0,canvas.width,canvas.height),matrices={
              Protanopie:[.567,.433,0,.558,.442,0,.242,.758,0],
              'Deutéranopie':[.625,.375,0,.7,.3,0,.3,.7,0],
              Tritanopie:[.95,.05,0,0,.433,.567,0,.475,.525],
              Achromatopsie:[.299,.587,.114,.299,.587,.114,.299,.587,.114],
            };
            const m=matrices[selected]||matrices.Protanopie;
            for(let i=0;i<pixels.data.length;i+=4){const [r,g,b]=pixels.data.slice(i,i+3);pixels.data[i]=r*m[0]+g*m[1]+b*m[2];pixels.data[i+1]=r*m[3]+g*m[4]+b*m[5];pixels.data[i+2]=r*m[6]+g*m[7]+b*m[8];}
            context.putImageData(pixels,0,0);previewHtml=`<img alt="Simulation" src="${canvas.toDataURL('image/png')}" style="max-width:100%">`;
            const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));download(blob,'simulation-daltonisme.png',state.urls);result=`Simulation ${selected.toLocaleLowerCase('fr')} · ${canvas.width} × ${canvas.height}`;image.close();break;
          }
          case 'palette-generator': {const [h,s,l]=rgbHsl(colorRgb(colorPicker.value));const offsets=selected==='Complémentaire'?[0,180]:selected==='Analogue'?[-30,-15,0,15,30]:selected==='Triadique'?[0,120,240]:selected==='Tétradique'?[0,90,180,270]:[-40,-20,0,20,40];const colors=offsets.map(d=>rgbHex(hslRgb(h+d,s,Math.min(90,Math.max(10,l+(d===0?0:d%2*4))))));result=colors.map((c,i)=>`--palette-${i+1}: ${c};`).join('\n');previewHtml=colors.map(c=>`<span style="display:inline-block;width:3rem;height:3rem;background:${c}" title="${c}"></span>`).join('');break;}
          case 'svg-to-raster': {const svg=new Blob([text],{type:'image/svg+xml'});const url=URL.createObjectURL(svg);state.urls.add(url);const img=new Image();img.src=url;await img.decode();const canvas=document.createElement('canvas');canvas.width=img.width||512;canvas.height=img.height||512;canvas.getContext('2d').drawImage(img,0,0);const blob=await new Promise(r=>canvas.toBlob(r,selected==='WebP'?'image/webp':'image/png'));download(blob,`image.${selected==='WebP'?'webp':'png'}`,state.urls);result=`Image exportée : ${canvas.width} × ${canvas.height}`;break;}
          case 'svg-optimizer': result=text.replace(/<!--[\s\S]*?-->/g,'').replace(/<metadata[\s\S]*?<\/metadata>/gi,'').replace(/<g>\s*<\/g>/g,'').replace(/>\s+</g,'><').replace(/\s{2,}/g,' ').replace(/(\d+\.\d{3,})/g,(n)=>Number(n).toFixed(2));status.textContent=`Taille : ${bytes(text.length)} → ${bytes(result.length)}`;break;
          case 'exif-reader': if(!state.file)throw new Error('Choisissez une image JPEG.');result=parseExif(await state.file.arrayBuffer());break;
          case 'file-splitter': {if(!state.file)throw new Error('Choisissez un fichier.');const chunkSize=Math.max(1,Number(other)||Math.ceil(state.file.size/count));const total=Math.ceil(state.file.size/chunkSize);for(let i=0;i<total;i++)download(state.file.slice(i*chunkSize,Math.min(state.file.size,(i+1)*chunkSize)),`${state.file.name}.part${String(i+1).padStart(3,'0')}`,state.urls);result=`${total} parties téléchargées · ${bytes(chunkSize)} maximum par partie`;break;}
          case 'text-to-slug': result=normalize(text).toLocaleLowerCase('fr').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');break;
          case 'text-encoding': result=`UTF-8 HEX: ${toHex(text)}\nUTF-8 binaire: ${Array.from(new TextEncoder().encode(text),b=>b.toString(2).padStart(8,'0')).join(' ')}`;break;
          case 'line-numberer': result=lines(text).map((l,i)=>`${String(i+1).padStart(String(lines(text).length).length,'0')}  ${l}`).join('\n');break;
          case 'word-frequency': {const m=new Map();words(text).forEach(w=>m.set(w.toLowerCase(),(m.get(w.toLowerCase())||0)+1));result=[...m].sort((a,b)=>b[1]-a[1]).slice(0,50).map(([w,n])=>`${w}: ${n}`).join('\n');break;}
          case 'timestamp-converter': {const n=Number(text);const date=/^\d+$/.test(text)?new Date(n<1e12?n*1000:n):new Date(text);if(Number.isNaN(+date))throw new Error('Date ou timestamp invalide.');result=`ISO : ${date.toISOString()}\nLocal : ${date.toLocaleString('fr-FR')}\nUnix secondes : ${Math.floor(+date/1000)}\nUnix millisecondes : ${+date}`;break;}
          case 'html-validator': {const doc=new DOMParser().parseFromString(text,'text/html');result=`Analyse locale terminée.\nTitre : ${doc.title||'Absent'}\nImages sans alt : ${doc.querySelectorAll('img:not([alt])').length}\nLiens sans href : ${doc.querySelectorAll('a:not([href])').length}\nÉléments : ${doc.body.querySelectorAll('*').length}`;break;}
          case 'random-generator': {const n=Number(text)||100;const max=Number(other)||1000000;result=Array.from({length:Math.min(100,count)},()=>randomInt(max-n+1)+n).join('\n');break;}
          case 'unit-converter': {const v=Number(text);const val=selected==='m → km'?v/1000:selected==='km → m'?v*1000:selected==='kg → lb'?v*2.2046226218:selected==='lb → kg'?v/2.2046226218:selected==='°C → °F'?v*9/5+32:(v-32)*5/9;result=String(val);break;}
          case 'percentage-calculator': {const v=Number(text),p=Number(other);result=`${p} % de ${v} = ${v*p/100}\nVariation relative : ${v?(p-v)/v*100:0} %`;break;}
          case 'rule-of-three': {const [a,b,c]=[Number(text),Number(other.split(',')[0]),Number(other.split(',')[1])];result=String(a&&b&&c?b*c/a:NaN);break;}
          case 'loan-calculator': {const principal=Number(text),rate=Number(other.split(',')[0])/1200,months=Number(other.split(',')[1])||12;const payment=rate?principal*rate/(1-(1+rate)**-months):principal/months;result=`Mensualité : ${payment.toFixed(2)}\nTotal : ${(payment*months).toFixed(2)}\nIntérêts : ${(payment*months-principal).toFixed(2)}`;break;}
          case 'bmi-calculator': {const [kg,cm]=[Number(text),Number(other)];const bmi=kg/((cm/100)**2);result=`IMC : ${bmi.toFixed(1)}\n${bmi<18.5?'Insuffisance pondérale':bmi<25?'Corpulence normale':bmi<30?'Surpoids':'Obésité'} (indication générale)`;break;}
          case 'age-calculator': {const d=new Date(text);if(Number.isNaN(+d))throw new Error('Date de naissance invalide.');const now=new Date();let age=now.getFullYear()-d.getFullYear();if(now<new Date(now.getFullYear(),d.getMonth(),d.getDate()))age--;result=`${age} ans · ${Math.floor((now-d)/86400000)} jours vécus`;break;}
          case 'number-base-converter': {const n=parseInt(text,10);if(!Number.isFinite(n))throw new Error('Nombre décimal invalide.');result=`Décimal ${n}\nBinaire ${n.toString(2)}\nOctal ${n.toString(8)}\nHexadécimal ${n.toString(16).toUpperCase()}`;break;}
          default: result='Outil prêt. Saisissez une valeur pour continuer.';
        }
        state.output=empty(result);
        output.textContent=state.output;
        if(previewHtml){preview.hidden=false;preview.innerHTML=previewHtml;}else{preview.hidden=true;preview.innerHTML='';}
        if(!status.textContent.includes('identique')&&!status.textContent.includes('suppprim'))status.textContent='Terminé.';
      } catch(err) {
        status.className='status-error';status.textContent=err.message||'Traitement impossible.';state.output='';output.textContent='';
      }
    };
    root.addEventListener('click', (event) => {
      const button=event.target.closest('button');
      if(!button)return;
      const boardAction=button.dataset.boardMove||button.dataset.boardDelete||button.dataset.boardEdit;
      if(boardAction&&id==='kanban-board'){
        const key='webapps-kanban',board=JSON.parse(localStorage.getItem(key)||'[]'),card=board.find(item=>item.id===boardAction);
        if(card){
          if(button.hasAttribute('data-board-delete'))board.splice(board.indexOf(card),1);
          else if(button.hasAttribute('data-board-move'))card.state=button.dataset.next;
          else{const revised=prompt('Modifier la tâche',card.text);if(revised!==null)card.text=revised.trim();}
          localStorage.setItem(key,JSON.stringify(board));perform();
        }
        return;
      }
      if(button.hasAttribute('data-sort')){const column=Number(button.dataset.sort),tbody=preview.querySelector('tbody'),sorted=[...tbody.rows].sort((a,b)=>a.cells[column].textContent.localeCompare(b.cells[column].textContent,'fr',{numeric:true}));sorted.forEach(row=>tbody.appendChild(row));return;}
      if(button.hasAttribute('data-run'))perform();
      if(button.hasAttribute('data-copy'))copyText(state.output).then(()=>{status.className='status-success';status.textContent='Résultat copié.';}).catch(()=>{status.className='status-error';status.textContent='Copie impossible.';});
      if(button.hasAttribute('data-download'))download(new Blob([state.output],{type:'text/plain;charset=utf-8'}),`${id}.txt`,state.urls);
    }, { signal: abort.signal });
    root.querySelector('[data-filter]')?.addEventListener('input',(event)=>{const query=event.target.value.toLocaleLowerCase('fr');preview.querySelectorAll('tbody tr').forEach(row=>{row.hidden=!row.textContent.toLocaleLowerCase('fr').includes(query);});},{signal:abort.signal});
    root.querySelector('[data-file]')?.addEventListener('change',(e)=>{const f=e.target.files?.[0];if(f)readFile(f).catch(err=>{status.className='status-error';status.textContent=err.message;});},{signal:abort.signal});
    root.querySelectorAll('textarea,input,select').forEach((el)=>el.addEventListener('keydown',(e)=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();perform();}},{signal:abort.signal}));
    if(['markdown-to-html','regex-tester','word-counter','color-converter'].includes(id)){
      root.addEventListener('input',()=>{
        clearTimeout(state.liveTimer);
        state.liveTimer=setTimeout(()=>perform(),160);
      },{signal:abort.signal});
    }
    if(id==='secure-notepad') {
      const title=root.querySelector('[data-title]');
      const noteKey=()=>`webapps-note-${title.value||'note'}`;
      input.value=localStorage.getItem(noteKey())||'';
      input.addEventListener('input',()=>localStorage.setItem(noteKey(),input.value),{signal:abort.signal});
      title.addEventListener('change',()=>{input.value=localStorage.getItem(noteKey())||'';},{signal:abort.signal});
    }
    if(id==='stopwatch-timer'||id==='pomodoro-timer') {
      const btn=document.createElement('button');btn.className='btn-secondary';btn.type='button';btn.textContent='Démarrer';root.querySelector('.tool-row').append(btn);
      let start=0,elapsed=0,running=false;
      const lap=document.createElement('button');lap.className='btn-secondary';lap.type='button';lap.textContent='Tour';root.querySelector('.tool-row').append(lap);
      lap.addEventListener('click',()=>{if(running)output.textContent+=`\nTour : ${status.textContent}`;},{signal:abort.signal});
      btn.addEventListener('click',()=>{
        if(running){elapsed+=Date.now()-start;running=false;btn.textContent='Reprendre';clearInterval(state.interval);}
        else{
          start=Date.now();running=true;btn.textContent='Pause';
          const countdown=id==='pomodoro-timer'||mode?.value==='Minuteur',duration=(Number(num?.value)||25)*60000;
          state.interval=setInterval(()=>{
            const ms=elapsed+Date.now()-start,remaining=countdown?Math.max(0,duration-ms):ms;
            status.textContent=`${Math.floor(remaining/60000)}:${String(Math.floor(remaining/1000)%60).padStart(2,'0')}`;
            if(countdown&&remaining===0){clearInterval(state.interval);running=false;btn.textContent='Démarrer';try{const audio=new AudioContext(),osc=audio.createOscillator();osc.connect(audio.destination);osc.start();osc.stop(audio.currentTime+.35);osc.onended=()=>audio.close();}catch(err){status.textContent=`Minuteur terminé : ${err.message}`;}}
          },200);
        }
      }, {signal:abort.signal});
    }
    if(id==='totp-generator')state.interval=setInterval(()=>{if(input.value.trim())perform();},1000);
    if(id==='world-clock')state.interval=setInterval(()=>{if(mode)status.textContent=new Intl.DateTimeFormat('fr-FR',{timeStyle:'medium',timeZone:mode.value}).format(new Date());},1000);
    window.lucide?.createIcons?.();
  };
  return { mount, unmount };
}

function sortKeys(value){if(Array.isArray(value))return value.map(sortKeys);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,sortKeys(value[k])]));return value;}
function flatten(obj,prefix='',out={}){for(const [k,v]of Object.entries(obj||{})){const key=prefix?`${prefix}.${k}`:k;if(v&&typeof v==='object'&&!Array.isArray(v))flatten(v,key,out);else out[key]=Array.isArray(v)?JSON.stringify(v):v;}return out;}
function cast(v){if(v==='true')return true;if(v==='false')return false;if(v!==''&&Number.isFinite(Number(v)))return Number(v);return v;}
function base32(input){const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits='';for(const c of input.toUpperCase().replace(/=|\s/g,'')){const n=alphabet.indexOf(c);if(n<0)throw new Error('Secret Base32 invalide.');bits+=n.toString(2).padStart(5,'0');}return Uint8Array.from(bits.match(/.{8}/g)||[],b=>parseInt(b,2));}
function addCalendarMonths(date,months){
  const next=new Date(date),day=next.getUTCDate();
  next.setUTCDate(1);next.setUTCMonth(next.getUTCMonth()+months);
  const last=new Date(Date.UTC(next.getUTCFullYear(),next.getUTCMonth()+1,0)).getUTCDate();
  next.setUTCDate(Math.min(day,last));
  return next;
}
function loadJsQr(){
  if(window.jsQR)return Promise.resolve();
  if(window.jsQrLoading)return window.jsQrLoading;
  window.jsQrLoading=new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src='https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
    script.onload=()=>window.jsQR?resolve():reject(new Error('Le lecteur QR de secours n’a pas pu démarrer.'));
    script.onerror=()=>reject(new Error('Impossible de charger le lecteur QR de secours.'));
    document.head.appendChild(script);
  });
  return window.jsQrLoading;
}
function parseExif(buffer){
  const view=new DataView(buffer);
  if(view.byteLength<4||view.getUint16(0)!==0xffd8)throw new Error('Ce fichier ne semble pas être un JPEG.');
  let pos=2,tiff=0;
  while(pos+4<view.byteLength){
    if(view.getUint8(pos)!==0xff)break;
    const marker=view.getUint8(pos+1),length=view.getUint16(pos+2);
    if(marker===0xe1&&view.getUint8(pos+4)===0x45&&view.getUint8(pos+5)===0x78&&view.getUint8(pos+6)===0x69&&view.getUint8(pos+7)===0x66){tiff=pos+10;break;}
    if(marker===0xda||length<2)break;
    pos+=length+2;
  }
  if(!tiff)throw new Error('Aucun segment EXIF trouvé dans cette image.');
  const little=view.getUint16(tiff)===0x4949;
  if(!little&&view.getUint16(tiff)!==0x4d4d)throw new Error('En-tête TIFF EXIF invalide.');
  const u16=(p)=>view.getUint16(p,little),u32=(p)=>view.getUint32(p,little);
  const sizes={1:1,2:1,3:2,4:4,5:8,7:1,9:4,10:8};
  const readIfd=(relative)=>{
    const start=tiff+relative;if(start+2>view.byteLength)return {};
    const result={};const count=Math.min(u16(start),512);
    for(let i=0;i<count;i++){
      const p=start+2+i*12;if(p+12>view.byteLength)break;
      const tag=u16(p),type=u16(p+2),n=u32(p+4),size=(sizes[type]||0)*n;
      const data=size<=4?p+8:tiff+u32(p+8);if(!size||data+size>view.byteLength)continue;
      let value;
      if(type===2){let end=data;while(end<data+n&&view.getUint8(end))end++;value=new TextDecoder().decode(new Uint8Array(buffer,data,end-data));}
      else if(type===3)value=n===1?u16(data):Array.from({length:Math.min(n,16)},(_,j)=>u16(data+j*2));
      else if(type===4||type===9)value=n===1?u32(data):Array.from({length:Math.min(n,16)},(_,j)=>u32(data+j*4));
      else if(type===5||type===10){const rational=(q)=>`${u32(q)}/${u32(q+4)}`;value=n===1?rational(data):Array.from({length:Math.min(n,16)},(_,j)=>rational(data+j*8));}
      else value=u32(p+8);
      result[tag]=value;
    }
    return result;
  };
  const base=readIfd(u32(tiff+4)),exif=base[0x8769]?readIfd(base[0x8769]):{},gps=base[0x8825]?readIfd(base[0x8825]):{};
  const names={0x010f:'Fabricant',0x0110:'Modèle',0x0132:'Date',0x9003:'Date de prise',0x829a:'Exposition',0x8827:'ISO',0x920a:'Focale'};
  const all={...base,...exif};const entries=Object.entries(names).filter(([tag])=>all[Number(tag)]!==undefined).map(([tag,label])=>`${label} : ${Array.isArray(all[Number(tag)])?all[Number(tag)].join(', '):all[Number(tag)]}`);
  const coordinate=(values,ref)=>{if(!Array.isArray(values)||values.length<3)return'';const decimal=values.map(v=>{const [a,b]=v.split('/').map(Number);return a/b;}).reduce((a,v,i)=>a+v/[1,60,3600][i],0);return `${ref==='S'||ref==='W'?-decimal:decimal.toFixed(6)}`;};
  if(gps[2]&&gps[4])entries.push(`GPS : ${coordinate(gps[2],gps[1])}, ${coordinate(gps[4],gps[3])}`);
  return entries.length?entries.join('\n'):'Segment EXIF présent, sans champs pris en charge.';
}
function barcodeData(value,kind){
  if(kind==='CODE128'){
    const patterns='212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112'.split(' ');
    if(!value||![...value].every(c=>c.charCodeAt(0)>=32&&c.charCodeAt(0)<=126))throw new Error('CODE128 accepte les caractères ASCII imprimables.');
    const codes=[104,...[...value].map(c=>c.charCodeAt(0)-32)];
    codes.push(codes.reduce((sum,c,i)=>sum+c*(i||1),0)%103,106);
    let x=0,markup='';
    for(const code of codes){let black=true;for(const width of patterns[code]){if(black)markup+=`<rect x="${x}" y="0" width="${width}" height="90"/>`;x+=Number(width);black=!black;}}
    return {markup,width:x,text:value};
  }
  const digits=value.replace(/\D/g,'');let n=digits;
  if(kind==='UPC-A'&&n.length===11){let sum=0;for(let i=0;i<11;i++)sum+=Number(n[i])*(i%2?1:3);n+=String((10-sum%10)%10);}
  if(kind==='EAN-13'&&n.length===12){let sum=0;for(let i=0;i<12;i++)sum+=Number(n[i])*(i%2?3:1);n+=String((10-sum%10)%10);}
  if(n.length!==(kind==='UPC-A'?12:13))throw new Error('Saisissez 12 chiffres EAN-13 (13 avec contrôle) ou 11 chiffres UPC-A.');
  const L=['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
  const R=L.map(v=>v.replace(/0/g,'x').replace(/1/g,'0').replace(/x/g,'1'));
  const parity=['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];
  let bits='101';
  for(let i=1;i<=6;i++){const p=kind==='UPC-A'?'LLLLLL':parity[Number(n[0])],d=Number(n[i]);bits+=(p[i-1]==='L'?L[d]:p[i-1]==='G'?L[d].split('').reverse().join(''):R[d]);if(i===6)bits+='01010';}
  for(let i=7;i<13;i++)bits+=R[Number(n[i])];bits+='101';
  return {markup:[...bits].map((b,i)=>b==='1'?`<rect x="${i}" y="0" width="1" height="${i<3||i>bits.length-4||i>=45&&i<=49?90:78}"/>`:'').join(''),width:bits.length,text:n};
}
