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
        ES: EU_STD, PT: EU_STD, CZ: EU_STD,
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
            let openCount = 0;
            shops.forEach(shop => {
                const st = shop.st = getStatus(shop, now);
                if (st.open) openCount++;
                const tx = statusTexts(st);
                shop.el.querySelector('.si-time').textContent = st.time;
                shop.el.querySelector('.si-timer').textContent = tx.timer;
                const b = shop.el.querySelector('.badge');
                b.textContent = tx.badge;
                b.className = 'badge ' + (st.open ? 'b-open' : 'b-closed');
            });
            $('open-count').textContent = T.openCount(openCount, shops.length);
            if (globe) globe.pointColor(d => d.st.open ? cfg.brandColor : cfg.closedColor);
        }

        function activateShop(id) {
            activeId = id;
            shops.forEach(s => s.el.classList.toggle('active', s.id === id));
            const shop = shops.find(s => s.id === id);
            if (!shop) return;
            shop.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            if (globe) {
                globe.controls().autoRotate = false;
                globe.pointOfView({ lat: shop.lat, lng: shop.lng, altitude: 1.5 }, 1500);
            }
        }

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
                    nightTex.needsUpdate = true;
                    sunUniform = { value: sunLight.position.clone() };
                    mat.onBeforeCompile = shader => {
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
                                'float sunDot = dot(normalize(vWorldN), normalize(sunDir));',
                                'float night = 1.0 - smoothstep(-0.12, 0.12, sunDot);',
                                'vec3 nTex = texture2D(nightMap, vMapUv).rgb;',
                                // fond de nuit bleuté + lumières des villes renforcées (les zones claires ressortent)
                                'float city = max(nTex.r - nTex.b * 0.5, 0.0);',
                                'vec3 nightCol = gl_FragColor.rgb * ' + (cfg.nightDim || 1.8).toFixed(2) +
                                    ' + nTex * 1.4 + vec3(1.0, 0.85, 0.6) * city * ' + (cfg.cityLights || 20).toFixed(2) + ';',
                                'gl_FragColor.rgb = mix(gl_FragColor.rgb, nightCol, night);'
                            ].join('\n'));
                    };
                    mat.needsUpdate = true;
                    updateSun();
                };
                waitForDayMap();
            };
            img.src = 'https://unpkg.com/three-globe@2.45.6/example/img/earth-night.jpg';
        }

        // --- GLOBE ---
        function initGlobe() {
            const area = $('globe-area');
            const tooltip = $('custom-tooltip');
            const viz = $('globeViz');
            $('loading-msg').style.display = 'none';

            let lastMouse = null;
            function placeTooltip() {
                if (!lastMouse || tooltip.style.display !== 'block') return;
                const r = area.getBoundingClientRect();
                let x = lastMouse.x - r.left + 15, y = lastMouse.y - r.top + 15;
                x = Math.max(0, Math.min(x, r.width - tooltip.offsetWidth - 10));
                y = Math.max(0, Math.min(y, r.height - tooltip.offsetHeight - 10));
                tooltip.style.left = x + 'px';
                tooltip.style.top = y + 'px';
            }

            try {
                globe = Globe()(viz)
                    .backgroundColor('#ffffff')
                    .globeImageUrl('https://unpkg.com/three-globe@2.45.6/example/img/earth-blue-marble.jpg')
                    .showAtmosphere(true)
                    .atmosphereColor(cfg.atmosphereColor)
                    .atmosphereAltitude(0.15)
                    .width(area.clientWidth)
                    .height(area.clientHeight)
                    .pointsData(shops)
                    .pointLat('lat').pointLng('lng')
                    .pointColor(d => d.st.open ? cfg.brandColor : cfg.closedColor)
                    .pointAltitude(0.03)
                    .pointRadius(0.7)
                    .pointsMerge(false)
                    .pointLabel(null)
                    .onPointClick(d => activateShop(d.id))
                    .onPointHover(d => {
                        viz.style.cursor = d ? 'pointer' : 'default';
                        if (!d) { tooltip.style.display = 'none'; return; }
                        const st = d.st, tx = statusTexts(st);
                        tooltip.innerHTML = `<div class="tt-meta"></div><h3></h3><div class="tt-status"></div><div class="tt-hours"></div>`;
                        tooltip.querySelector('.tt-meta').textContent = d.country;
                        tooltip.querySelector('h3').textContent = d.name;
                        const ts = tooltip.querySelector('.tt-status');
                        ts.textContent = `${tx.badge} - ${st.time}`;
                        ts.style.color = st.open ? cfg.brandColor : cfg.closedColor;
                        tooltip.querySelector('.tt-hours').textContent =
                            st.todayHours ? `${T.today} : ${st.todayHours}` : T.closedToday;
                        tooltip.style.display = 'block';
                        placeTooltip();
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
                viz.addEventListener('mouseenter', () => { controls.autoRotate = false; });
                viz.addEventListener('mouseleave', () => { controls.autoRotate = true; });

                // Infobulle qui suit la souris (coordonnées relatives à la zone du globe)
                viz.addEventListener('mousemove', e => {
                    lastMouse = { x: e.clientX, y: e.clientY };
                    placeTooltip();
                });
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
        });

        window.activateShop = activateShop;
    };
})();
