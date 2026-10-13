/*
 * splash.js: the hero's art on apaki.myrlin.io (relay/site/index.html), a slow mesh gradient drawn by one small
 * WebGL fragment shader in a skewed band behind the wordmark. Written 2026-10-12 by Claude Code (Opus 5.5) for
 * Arthur, after his note on the page ("think about landing page splash art instead of just the generic
 * background ... webgl maybe? lightweight? look at stripes cool animation").
 *
 * What it draws: the page's warm palette (pearl, peach, apricot, a sand rose) moving like silk through
 * domain-warped simplex noise, with one thin thread of the logo flare's cyan. No library: about 4 KB.
 *
 * Cost: the canvas renders at half the band's CSS width at most (and never above 900 px wide), so the browser
 * scales a small, soft image up; frames are capped near 30 a second.
 * Quiet: it stops when the band is off screen or the tab is hidden; under prefers-reduced-motion it draws one
 * still frame. Without WebGL (or if the context is lost) the CSS poster under it (site.css .splash) stays.
 * Only the page's own files are loaded (the CSP is script-src 'self'); no storage, no network.
 */
(function () {
  'use strict';

  var box = document.querySelector('.splash');
  var canvas = box && box.querySelector('canvas');
  if (!canvas) return;
  var gl = null;
  try {
    gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'low-power' });
  } catch (e) { gl = null; }
  if (!gl) return;

  var VERT = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.0,1.0);}';
  // 2D simplex noise after Ashima Arts and Stefan Gustavson (MIT), then a domain-warped blend of five colours.
  var FRAG = [
    'precision mediump float;',
    'uniform vec2 u_res;uniform float u_t;uniform vec3 u_c[5];',
    'vec3 perm(vec3 x){return mod(((x*34.0)+1.0)*x,289.0);}',
    'float sn(vec2 v){',
    ' const vec4 C=vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);',
    ' vec2 i=floor(v+dot(v,C.yy));vec2 x0=v-i+dot(i,C.xx);',
    ' vec2 i1=(x0.x>x0.y)?vec2(1.0,0.0):vec2(0.0,1.0);',
    ' vec4 x12=x0.xyxy+C.xxzz;x12.xy-=i1;i=mod(i,289.0);',
    ' vec3 p=perm(perm(i.y+vec3(0.0,i1.y,1.0))+i.x+vec3(0.0,i1.x,1.0));',
    ' vec3 m=max(0.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.0);m=m*m;m=m*m;',
    ' vec3 x=2.0*fract(p*C.www)-1.0;vec3 h=abs(x)-0.5;vec3 ox=floor(x+0.5);vec3 a0=x-ox;',
    ' m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);',
    ' vec3 g;g.x=a0.x*x0.x+h.x*x0.y;g.yz=a0.yz*x12.xz+h.yz*x12.yw;return 130.0*dot(m,g);}',
    'void main(){',
    ' vec2 uv=gl_FragCoord.xy/u_res;',
    // Stretched along a slant, so the colour runs in long skewed ribbons rather than blobs.
    ' vec2 p=vec2(uv.x*u_res.x/u_res.y,uv.y);p=vec2(p.x*0.55+p.y*0.35,p.y*1.15-p.x*0.18);',
    ' float t=u_t*0.05;',
    ' vec2 q=vec2(sn(p*0.9+vec2(t,-t*0.6)),sn(p*0.9+vec2(-t*0.7,t)+5.2));',
    ' vec2 w=p+0.6*q;',
    ' float f1=sn(w*1.1+vec2(t*0.8,0.0));',
    ' float f2=sn(w*1.5+vec2(0.0,-t*0.9)+9.1);',
    ' float f3=sn(w*0.7+vec2(-t*0.5,t*0.3)+3.7);',
    ' vec3 col=u_c[0];',
    ' col=mix(col,u_c[1],smoothstep(-0.3,0.65,f1)*0.9);',
    ' col=mix(col,u_c[2],smoothstep(-0.05,0.8,f2)*0.8);',
    ' col=mix(col,u_c[3],smoothstep(0.15,0.9,f3)*0.65);',
    ' float th=1.0-smoothstep(0.0,0.16,abs(f2-0.46));',
    // The flare's cyan as one soft ribbon, only toward the top right, so it reads as a glint, not a line.
    ' col=mix(col,u_c[4],th*0.22*smoothstep(0.45,0.95,uv.x)*smoothstep(0.35,0.95,uv.y));',
    ' col+=(fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453)-0.5)/255.0;',
    ' gl_FragColor=vec4(col,1.0);}',
  ].join('\n');

  function shader(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  }
  var vs = shader(gl.VERTEX_SHADER, VERT);
  var fs = shader(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return;
  var prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
  gl.useProgram(prog);

  // One triangle that covers the whole canvas.
  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(prog, 'a');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  var uRes = gl.getUniformLocation(prog, 'u_res');
  var uT = gl.getUniformLocation(prog, 'u_t');
  var uC = gl.getUniformLocation(prog, 'u_c');

  /* The palette, per theme: pearl, peach, apricot, sand rose, and the flare's cyan for the one thread. */
  var PALETTE = {
    light: ['#FBF3EA', '#F7BE9C', '#FAD7B6', '#F1CBBE', '#4FC0D6'],
    dark: ['#110D0A', '#4E2416', '#B15E38', '#231813', '#1690A8'],
  };
  var root = document.documentElement;
  function theme() { return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }
  function colours() {
    var out = [];
    PALETTE[theme()].forEach(function (hex) {
      for (var k = 1; k < 7; k += 2) out.push(parseInt(hex.slice(k, k + 2), 16) / 255);
    });
    gl.uniform3fv(uC, new Float32Array(out));
  }

  var SCALE = 0.5;
  var MAX_W = 900;
  function size() {
    var r = box.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var w = Math.max(64, Math.round(Math.min(r.width * SCALE, MAX_W)));
    var h = Math.max(32, Math.round((r.height * w) / r.width));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  var reducedMq = window.matchMedia('(prefers-reduced-motion: reduce)');
  // Seconds of motion so far; it starts part way in, so the first frame is not a "start" pose, and it only advances while drawing.
  var clock = 41;
  var prev = 0;
  var last = 0;
  var raf = 0;
  var onScreen = true;
  var lost = false;

  function draw() {
    if (lost) return;
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uT, clock);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    box.classList.add('is-gl');
  }

  function frame(now) {
    raf = 0;
    if (!wanted()) { prev = 0; return; }
    if (prev) clock += Math.min(0.1, (now - prev) / 1000);
    prev = now;
    // About 30 frames a second is plenty for something this slow.
    if (now - last >= 32) { last = now; draw(); }
    raf = window.requestAnimationFrame(frame);
  }

  function wanted() { return onScreen && !document.hidden && !reducedMq.matches && !lost; }

  function update() {
    if (wanted()) {
      if (!raf) raf = window.requestAnimationFrame(frame);
    } else {
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
      prev = 0;
      draw(); // the still frame (reduced motion), or the frame it stopped on
    }
  }

  colours();
  size();
  draw();
  update();

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      onScreen = entries[entries.length - 1].isIntersecting;
      update();
    }).observe(box);
  }
  document.addEventListener('visibilitychange', update);
  if (reducedMq.addEventListener) reducedMq.addEventListener('change', update);
  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(function () { size(); draw(); }, 120);
  }, { passive: true });
  // theme.js flips data-theme with the system setting; the palette follows.
  new MutationObserver(function () { colours(); draw(); }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  canvas.addEventListener('webglcontextlost', function (e) {
    e.preventDefault();
    lost = true;
    box.classList.remove('is-gl'); // the CSS poster shows again
    update();
  });
})();
