/*
 * Global Monitor - logique commune (Cartier / Van Cleef & Arpels)
 *
 * Format d'une boutique : [nom, pays affiché, code pays ISO, fuseau IANA, lat, lng, horaires]
 * Horaires : 7 blocs séparés par des espaces, du DIMANCHE au SAMEDI.
 *   "-"                 = fermé ce jour-là
 *   "1000-1900"         = 10:00 -> 19:00
 *   "1030-1300,1430-1900" = coupure de midi
 *   "1000-0"            = fermeture à minuit (une fin <= début passe au lendemain)
 *   "1000-1900*6"       = le même bloc répété 6 fois
 * Exemple : "1200-1800 1000-1900*6" = dimanche 12-18h, lundi au samedi 10-19h.
 */
(function () {
    'use strict';

    // Jours fériés où les boutiques ferment (dates fixes MM-JJ, + Thanksgiving aux USA).
    // Volontairement simplifié : seules les fermetures quasi certaines sont listées.
    const EU_STD = ['01-01', '05-01', '12-25'];
    const HOLIDAYS = {
        FR: EU_STD, MC: EU_STD, BE: EU_STD, DE: EU_STD, AT: EU_STD, IT: EU_STD,
        ES: EU_STD, PT: EU_STD, CZ: EU_STD, GR: EU_STD,
        SE: ['01-01', '12-25'], NZ: ['12-25'],
        CH: ['01-01', '12-25'], NL: ['01-01', '12-25'], GB: ['12-25'],
        US: ['12-25', 'THANKSGIVING'], CA: ['12-25'],
        MX: ['01-01', '12-25'], BR: ['01-01', '12-25'], BL: ['01-01', '12-25'],
        AU: ['12-25']
    };

    function isHoliday(cc, y, m, d, dow) {
        const list = HOLIDAYS[cc];
        if (!list) return false;
        const key = String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
        if (list.includes(key)) return true;
        // Thanksgiving = 4e jeudi de novembre
        return list.includes('THANKSGIVING') && m === 11 && dow === 4 && d >= 22 && d <= 28;
    }

    function parseHours(str, name) {
        const toks = [];
        str.trim().split(/\s+/).forEach(tok => {
            const rep = tok.match(/^(.+)\*(\d)$/);
            if (rep) { for (let i = 0; i < +rep[2]; i++) toks.push(rep[1]); }
            else toks.push(tok);
        });
        if (toks.length !== 7) console.warn('Horaires invalides pour', name, str);
        const toMin = x => { x = x.padStart(4, '0'); return (+x.slice(0, 2)) * 60 + (+x.slice(2)); };
        return toks.slice(0, 7).map(tok => tok === '-' ? [] : tok.split(',').map(r => {
            const [a, b] = r.split('-').map(toMin);
            return [a, b <= a ? b + 1440 : b];
        }).sort((p, q) => p[0] - q[0]));
    }

    const fmtCache = {};
    function localParts(tz, now) {
        const f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: 'numeric', hourCycle: 'h23'
        }));
        const p = {};
        f.formatToParts(now).forEach(x => { p[x.type] = x.value; });
        const h = (+p.hour) % 24;
        return { y: +p.year, m: +p.month, d: +p.day, min: h * 60 + (+p.minute) };
    }

    const hhmm = min => String(Math.floor(min / 60) % 24).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');

    function getStatus(shop, now) {
        const L = localParts(shop.tz, now);
        const t = L.min;
        const day = k => {
            const dt = new Date(Date.UTC(L.y, L.m - 1, L.d + k));
            const dow = dt.getUTCDay();
            const hol = isHoliday(shop.cc, dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), dow);
            return { hol, iv: hol ? [] : shop.sched[dow] };
        };
        const today = day(0), yesterday = day(-1);
        const time = hhmm(t);

        // Ouvert maintenant ? (créneau du jour, ou créneau d'hier qui déborde après minuit)
        let closeIn = null;
        today.iv.forEach(([s, e]) => { if (t >= s && t < e) closeIn = e - t; });
        yesterday.iv.forEach(([s, e]) => { if (e > 1440 && t < e - 1440) closeIn = Math.max(closeIn || 0, e - 1440 - t); });

        const todayHours = today.iv.map(([s, e]) => hhmm(s) + '–' + hhmm(e)).join(', ');
        if (closeIn !== null) return { open: true, time, mins: closeIn, hol: false, todayHours };

        // Prochaine ouverture (jusqu'à 14 jours, jours fermés et fériés inclus)
        for (let k = 0; k <= 14; k++) {
            const D = day(k);
            for (const [s] of D.iv) {
                const at = k * 1440 + s;
                if (at > t) return { open: false, time, mins: at - t, hol: today.hol, todayHours };
            }
        }
        return { open: false, time, mins: null, hol: today.hol, todayHours };
    }

    function sunPosition(now) {
        const start = Date.UTC(now.getUTCFullYear(), 0, 0);
        const dayOfYear = (now.getTime() - start) / 86400000;
        const lat = -23.44 * Math.cos(2 * Math.PI / 365 * (dayOfYear + 10)); // déclinaison solaire
        const utcH = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
        let lng = (12 - utcH) * 15;                                           // le soleil est au zénith à midi UTC sur le méridien 0
        if (lng < -180) lng += 360;
        return { lat, lng };
    }

    window.__monitorCore = { getStatus, parseHours, sunPosition, isHoliday };

    window.initMonitor = function (cfg) {
        const T = cfg.text;
        const shops = cfg.shops.map((r, i) => ({
            id: i + 1, name: r[0], country: r[1], cc: r[2], tz: r[3], lat: r[4], lng: r[5],
            sched: parseHours(r[6], r[0])
        })).sort((a, b) => b.lng - a.lng); // Est -> Ouest

        const $ = id => document.getElementById(id);
        const list = $('list-container');
        let activeId = null;
        let query = '';

        // Texte de recherche : nom, pays affiché, code pays, nom du pays en FR et EN, sans accents
        const norm = str => String(str).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const countryNames = cc => ['fr', 'en'].map(l => {
            try { return new Intl.DisplayNames([l], { type: 'region' }).of(cc) || ''; } catch (e) { return ''; }
        }).join(' ');
        shops.forEach(s => {
            s.search = norm([s.name, s.country, s.cc, countryNames(s.cc)].join(' '));
        });
        const matches = s => !query || query.split(/\s+/).every(w => s.search.includes(w));
        let globe = null, sunLight = null;

        const fmtTimer = mins => {
            if (mins === null) return '';
            const m = Math.floor(mins);
            const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
            return d > 0 ? `${d}${T.dayUnit} ${String(h).padStart(2, '0')}h` : `${h}h ${String(mm).padStart(2, '0')}`;
        };

        function statusTexts(st) {
            return {
                badge: st.open ? T.open : (st.hol ? T.holiday : T.closed),
                timer: st.mins === null ? T.unknown : `${st.open ? T.closesIn : T.opensIn} ${fmtTimer(st.mins)}`
            };
        }

        // --- RECHERCHE ---
        const searchBox = document.createElement('input');
        searchBox.type = 'search';
        searchBox.id = 'search';
        searchBox.placeholder = T.searchPlaceholder || 'Search';
        searchBox.autocomplete = 'off';
        document.querySelector('.header').appendChild(searchBox);
        const noResults = document.createElement('div');
        noResults.id = 'no-results';
        noResults.textContent = T.noResults || 'No results';
        list.appendChild(noResults);
        searchBox.addEventListener('input', () => { query = norm(searchBox.value.trim()); applyFilter(); });
        searchBox.addEventListener('keydown', e => {
            if (e.key === 'Enter') { const first = shops.find(matches); if (first) activateShop(first.id); }
            if (e.key === 'Escape') { searchBox.value = ''; query = ''; applyFilter(); }
        });

        function applyFilter() {
            let n = 0;
            shops.forEach(s => { const ok = matches(s); s.el.style.display = ok ? '' : 'none'; if (ok) n++; });
            noResults.style.display = n ? 'none' : 'block';
            recluster(true);
            updateCount();
        }

        function updateCount() {
            const visible = shops.filter(matches);
            $('open-count').textContent = T.openCount(visible.filter(s => s.st && s.st.open).length, visible.length);
        }

        // --- LISTE ---
        shops.forEach(shop => {
            const div = document.createElement('div');
            div.className = 'shop-item';
            div.id = 'item-' + shop.id;
            div.onclick = () => activateShop(shop.id);
            div.innerHTML = `
                <div class="si-info">
                    <span class="si-country"></span>
                    <span class="si-name"></span>
                </div>
                <div class="si-status">
                    <div class="si-time"></div>
                    <div class="si-timer"></div>
                    <div class="badge"></div>
                </div>`;
            div.querySelector('.si-country').textContent = shop.country;
            div.querySelector('.si-name').textContent = shop.name;
            shop.el = div;
            list.appendChild(div);
        });

        function refresh() {
            const now = new Date();
            shops.forEach(shop => {
                const st = shop.st = getStatus(shop, now);
                const tx = statusTexts(st);
                shop.el.querySelector('.si-time').textContent = st.time;
                shop.el.querySelector('.si-timer').textContent = tx.timer;
                const b = shop.el.querySelector('.badge');
                b.textContent = tx.badge;
                b.className = 'badge ' + (st.open ? 'b-open' : 'b-closed');
            });
            updateCount();
            paintMarkers();
        }

        function activateShop(id) {
            activeId = id;
            shops.forEach(s => s.el.classList.toggle('active', s.id === id));
            const shop = shops.find(s => s.id === id);
            if (!shop) return;
            shop.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            closePopup();
            paintMarkers();
            if (globe) {
                globe.controls().autoRotate = false;
                globe.pointOfView({ lat: shop.lat, lng: shop.lng, altitude: 0.9 }, 1500);
            }
        }

        // --- MARQUEURS (pastilles à taille fixe + regroupement) ---
        // Les boutiques trop proches à l'écran (< CLUSTER_PX) sont fusionnées en une pastille « ouvertes/total ».
        const CLUSTER_PX = 26, EARTH_KM = 6371;
        let clusterKey = '', clusterCache = new Map(), currentClusters = [], popupOpen = false;

        const kmPerPx = alt => 2 * Math.tan(25 * Math.PI / 180) * alt * EARTH_KM / (($('globe-area').clientHeight) || 800);
        function km(a, b) {
            const t = Math.PI / 180, dLat = (b.lat - a.lat) * t, dLng = (b.lng - a.lng) * t;
            const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLng / 2) ** 2;
            return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
        }

        function recluster(force) {
            if (!globe) return;
            const thr = CLUSTER_PX * kmPerPx(globe.pointOfView().altitude);
            const groups = [];
            shops.filter(matches).forEach(s => {
                const g = groups.find(g => km(g, s) < thr);
                if (g) {
                    g.members.push(s);
                    g.lat = g.members.reduce((t, m) => t + m.lat, 0) / g.members.length;
                    g.lng = g.members.reduce((t, m) => t + m.lng, 0) / g.members.length;
                } else groups.push({ lat: s.lat, lng: s.lng, members: [s] });
            });
            const key = groups.map(g => g.members.map(m => m.id).sort((a, b) => a - b).join(',')).sort().join('|');
            if (key === clusterKey && !force) return;
            clusterKey = key;
            const next = new Map();
            currentClusters = groups.map(g => {
                const k = g.members.map(m => m.id).sort((a, b) => a - b).join(',');
                const c = clusterCache.get(k) || { k, members: g.members };
                c.lat = g.lat; c.lng = g.lng; c.members = g.members;
                next.set(k, c);
                return c;
            });
            clusterCache = next;
            globe.htmlElementsData(currentClusters);
            paintMarkers();
        }

        function markerEl(c) {
            if (c.el) return c.el;
            const el = document.createElement('div');
            el.className = 'mk';
            el.innerHTML = '<span class="mk-dot"></span><span class="mk-label"></span>';
            el.addEventListener('mouseenter', () => showTip(c));
            el.addEventListener('mouseleave', () => { $('custom-tooltip').style.display = 'none'; });
            el.addEventListener('click', e => { e.stopPropagation(); onMarkerClick(c); });
            // La molette au-dessus d'une pastille doit continuer à zoomer le globe
            el.addEventListener('wheel', e => {
                e.preventDefault();
                globe.renderer().domElement.dispatchEvent(new WheelEvent('wheel', {
                    deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode,
                    clientX: e.clientX, clientY: e.clientY, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey,
                    bubbles: true, cancelable: true
                }));
            }, { passive: false });
            c.el = el;
            paintMarker(c);
            return el;
        }

        function paintMarker(c) {
            if (!c.el) return;
            const n = c.members.length, open = c.members.filter(m => m.st && m.st.open).length;
            c.el.classList.toggle('mk-cluster', n > 1);
            c.el.classList.toggle('mk-open', open > 0);
            c.el.classList.toggle('mk-active', c.members.some(m => m.id === activeId));
            c.el.querySelector('.mk-dot').textContent = n > 1 ? open + '/' + n : '';
            c.el.querySelector('.mk-label').textContent = n > 1 ? c.members[0].name.split(' - ')[0] : c.members[0].name;
        }
        function paintMarkers() { currentClusters.forEach(paintMarker); }

        function showTip(c) {
            const tooltip = $('custom-tooltip'), area = $('globe-area');
            if (popupOpen) return;
            tooltip.innerHTML = '';
            const add = (tag, cls, text, color) => {
                const e = document.createElement(tag);
                if (cls) e.className = cls;
                e.textContent = text;
                if (color) e.style.color = color;
                tooltip.appendChild(e);
            };
            if (c.members.length === 1) {
                const d = c.members[0], st = d.st, tx = statusTexts(st);
                add('div', 'tt-meta', d.country);
                add('h3', '', d.name);
                add('div', 'tt-status', tx.badge + ' - ' + st.time, st.open ? cfg.brandColor : cfg.closedColor);
                add('div', 'tt-hours', st.todayHours ? T.today + ' : ' + st.todayHours : T.closedToday);
            } else {
                add('div', 'tt-meta', c.members.length + ' boutiques');
                c.members.forEach(m => add('div', 'tt-row', (m.st.open ? '● ' : '○ ') + m.name + '  ' + m.st.time, m.st.open ? cfg.brandColor : cfg.closedColor));
            }
            tooltip.style.display = 'block';
            const r = area.getBoundingClientRect(), b = c.el.getBoundingClientRect();
            let x = b.right - r.left + 12, y = b.top - r.top - 6;
            x = Math.max(0, Math.min(x, r.width - tooltip.offsetWidth - 10));
            y = Math.max(0, Math.min(y, r.height - tooltip.offsetHeight - 10));
            tooltip.style.left = x + 'px';
            tooltip.style.top = y + 'px';
        }

        function onMarkerClick(c) {
            $('custom-tooltip').style.display = 'none';
            if (c.members.length === 1) { activateShop(c.members[0].id); return; }
            // Altitude à laquelle les membres du groupe se séparent
            let minKm = Infinity;
            c.members.forEach((a, i) => c.members.slice(i + 1).forEach(b => { minKm = Math.min(minKm, km(a, b)); }));
            const altNeeded = minKm / (CLUSTER_PX * kmPerPx(1)) * 0.8;
            globe.controls().autoRotate = false;
            if (altNeeded >= MIN_ALT) {
                globe.pointOfView({ lat: c.lat, lng: c.lng, altitude: Math.max(MIN_ALT, Math.min(altNeeded, globe.pointOfView().altitude * 0.6)) }, 1200);
            } else {
                openPopup(c); // trop proches pour être séparées : liste cliquable
            }
        }

        function openPopup(c) {
            closePopup();
            const pop = document.createElement('div');
            pop.id = 'cluster-pop';
            c.members.forEach(m => {
                const row = document.createElement('div');
                row.className = 'cp-row' + (m.st.open ? ' cp-open' : '');
                row.innerHTML = '<span class="cp-dot"></span><span class="cp-name"></span><span class="cp-time"></span>';
                row.querySelector('.cp-name').textContent = m.name;
                row.querySelector('.cp-time').textContent = m.st.time;
                row.addEventListener('click', () => activateShop(m.id));
                pop.appendChild(row);
            });
            const area = $('globe-area');
            area.appendChild(pop);
            const r = area.getBoundingClientRect(), b = c.el.getBoundingClientRect();
            pop.style.left = Math.max(0, Math.min(b.right - r.left + 10, r.width - pop.offsetWidth - 10)) + 'px';
            pop.style.top = Math.max(0, Math.min(b.top - r.top - 10, r.height - pop.offsetHeight - 10)) + 'px';
            popupOpen = true;
        }
        function closePopup() {
            const pop = $('cluster-pop');
            if (pop) pop.remove();
            popupOpen = false;
        }
        document.addEventListener('mousedown', e => { if (popupOpen && !e.target.closest('#cluster-pop')) closePopup(); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') closePopup(); });

        // --- HORLOGE UTC ---
        function updateClock() {
            const now = new Date();
            $('utc-clock').textContent = String(now.getUTCHours()).padStart(2, '0') + ':' +
                String(now.getUTCMinutes()).padStart(2, '0') + ' UTC';
        }

        // --- SOLEIL (jour / nuit) ---
        let sunUniform = null;
        function updateSun() {
            if (!globe || !sunLight) return;
            const s = sunPosition(new Date());
            const c = globe.getCoords(s.lat, s.lng, 100);
            sunLight.position.set(c.x, c.y, c.z);
            if (sunUniform) sunUniform.value.set(c.x, c.y, c.z);
        }

        // --- LUMIÈRES DES VILLES sur la face nuit ---
        // On greffe la texture de nuit dans le matériau du globe : elle apparaît
        // progressivement de l'autre côté de la ligne jour/nuit.
        function addCityLights() {
            const mat = globe.globeMaterial();
            if (!mat || !sunLight) return;
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                // Les classes three.js ne sont pas exposées par globe.gl : on attend la texture
                // de jour pour réutiliser son constructeur (même instance de three.js).
                const waitForDayMap = () => {
                    if (!mat.map) { setTimeout(waitForDayMap, 200); return; }
                    const nightTex = new mat.map.constructor(img);
                    nightTex.colorSpace = mat.map.colorSpace;
                    nightTex.generateMipmaps = false;  // évite une couture à la longitude 180°
                    nightTex.minFilter = 1006;         // THREE.LinearFilter
                    nightTex.needsUpdate = true;
                    sunUniform = { value: sunLight.position.clone() };
                    // Les coordonnées de la texture de nuit sont recalculées depuis la normale :
                    // ça marche aussi bien sur le globe que sur les tuiles satellite.
                    // gain : éclaircit l'imagerie satellite (plus sombre que la texture du globe)
                    const nightShader = gain => shader => {
                        shader.uniforms.nightMap = { value: nightTex };
                        shader.uniforms.sunDir = sunUniform;
                        shader.vertexShader = shader.vertexShader
                            .replace('#include <common>', '#include <common>\nvarying vec3 vWorldN;')
                            .replace('#include <beginnormal_vertex>',
                                '#include <beginnormal_vertex>\nvWorldN = normalize(mat3(modelMatrix) * objectNormal);');
                        shader.fragmentShader = shader.fragmentShader
                            .replace('#include <common>',
                                '#include <common>\nuniform sampler2D nightMap;\nuniform vec3 sunDir;\nvarying vec3 vWorldN;')
                            .replace('#include <dithering_fragment>', [
                                '#include <dithering_fragment>',
                                'gl_FragColor.rgb *= ' + gain.toFixed(2) + ';',
                                'vec3 wn = normalize(vWorldN);',
                                'float sunDot = dot(wn, normalize(sunDir));',
                                'float night = 1.0 - smoothstep(-0.12, 0.12, sunDot);',
                                'float latR = asin(clamp(wn.y, -1.0, 1.0));',
                                'float lngR = 1.5707963 - atan(wn.z, wn.x);',
                                'vec2 nUv = vec2(fract((lngR + 3.1415927) / 6.2831853), (latR + 1.5707963) / 3.1415927);',
                                'vec3 nTex = texture2D(nightMap, nUv).rgb;',
                                // fond de nuit bleuté + lumières des villes renforcées (les zones claires ressortent)
                                'float city = max(nTex.r - nTex.b * 0.5, 0.0);',
                                'vec3 nightCol = gl_FragColor.rgb * ' + (cfg.nightDim || 1.8).toFixed(2) +
                                    ' + nTex * 1.4 + vec3(1.0, 0.85, 0.6) * city * ' + (cfg.cityLights || 20).toFixed(2) + ';',
                                'gl_FragColor.rgb = mix(gl_FragColor.rgb, nightCol, night);'
                            ].join('\n'));
                    };
                    const patch = (m, gain) => {
                        if (m.__night) return;
                        m.__night = true;
                        m.onBeforeCompile = nightShader(gain);
                        m.customProgramCacheKey = () => 'night-' + gain;
                        m.needsUpdate = true;
                    };
                    patch(mat, 1);
                    // Les tuiles satellite sont créées au fil du zoom : on leur applique le même effet
                    setInterval(() => globe.scene().traverse(o => {
                        if (o.isMesh && o.material && o.material.isMeshLambertMaterial) patch(o.material, cfg.tileBrightness || 1.6);
                    }), 300);
                    updateSun();
                };
                waitForDayMap();
            };
            img.src = 'https://unpkg.com/three-globe@2.45.6/example/img/earth-night.jpg';
        }

        // --- GLOBE ---
        // Imagerie satellite en tuiles (NASA GIBS, domaine public), utilisée seulement en vue rapprochée
        const TILE_URL = (x, y, l) => 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration/default/GoogleMapsCompatible_Level8/' + l + '/' + y + '/' + x + '.jpeg';
        const TILES_BELOW = 0.7;
        const MIN_ALT = 0.12, MAX_ALT = 3.2; // altitude en rayons terrestres (vue par défaut : 2.5)
        let tilesOn = false;
        function initGlobe() {
            const area = $('globe-area');
            const tooltip = $('custom-tooltip');
            const viz = $('globeViz');
            $('loading-msg').style.display = 'none';

            try {
                globe = Globe()(viz)
                    .backgroundColor('#ffffff')
                    .globeImageUrl('https://unpkg.com/three-globe@2.45.6/example/img/earth-blue-marble.jpg')
                    .globeTileEngineMaxLevel(8)
                    .showAtmosphere(true)
                    .atmosphereColor(cfg.atmosphereColor)
                    .atmosphereAltitude(0.15)
                    .width(area.clientWidth)
                    .height(area.clientHeight)
                    .htmlElementsData([])
                    .htmlLat('lat').htmlLng('lng').htmlAltitude(0.005)
                    .htmlElement(markerEl)
                    .htmlTransitionDuration(0)
                    .htmlElementVisibilityModifier((el, visible) => { el.classList.toggle('mk-hidden', !visible); })
                    .onZoom(pov => {
                        recluster();
                        // En vue rapprochée, on passe sur l'imagerie satellite en tuiles (plus nette)
                        const wantTiles = pov.altitude < TILES_BELOW;
                        if (wantTiles !== tilesOn) { tilesOn = wantTiles; globe.globeTileEngineUrl(wantTiles ? TILE_URL : null); }
                        $('globeViz').classList.toggle('show-labels', pov.altitude < 0.7);
                    });

                // Lumières : on réutilise celles de globe.gl (pas besoin de charger three.js à part)
                const lights = globe.lights();
                const ambient = lights.find(l => l.isAmbientLight);
                sunLight = lights.find(l => l.isDirectionalLight);
                if (ambient) ambient.intensity = cfg.ambientIntensity || 0.9; // éclairage de la face nuit
                if (sunLight) sunLight.intensity = 3.2;
                const mat = globe.globeMaterial();
                if (mat) mat.shininess = 4;
                updateSun();
                addCityLights();

                // Rotation auto, en pause quand la souris est sur le globe
                const controls = globe.controls();
                controls.autoRotate = true;
                controls.autoRotateSpeed = 0.5;
                // Limites du zoom : ni trop près (l'imagerie devient floue), ni trop loin
                controls.minDistance = 100 * (1 + MIN_ALT);
                controls.maxDistance = 100 * (1 + MAX_ALT);
                area.addEventListener('mouseenter', () => { controls.autoRotate = false; });
                area.addEventListener('mouseleave', () => { if (!popupOpen) controls.autoRotate = true; });
                controls.addEventListener('start', closePopup);
                recluster(true);
                $('copyright').textContent += ' · Imagery: NASA GIBS';
                window.monitorGlobe = globe; // accès console pour le débogage
            } catch (e) {
                console.error('Globe failed', e);
                $('loading-msg').style.display = 'block';
                $('loading-msg').textContent = T.globeError;
            }
        }

        refresh();
        updateClock();
        setInterval(updateClock, 1000);
        setInterval(() => { refresh(); updateSun(); }, 30000);
        initGlobe();

        window.addEventListener('resize', () => {
            if (!globe) return;
            const c = $('globe-area');
            globe.width(c.clientWidth).height(c.clientHeight);
            recluster();
        });

        window.activateShop = activateShop;
    };
})();
