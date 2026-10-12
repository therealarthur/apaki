/*
 * site.js: the moving parts of Apaki's home page (relay/site/index.html, apaki.myrlin.io).
 * Written 2026-10-12 by Claude Code (Opus 5.5) for Arthur, after the demo-video technique in
 * apaki/docs/research/2026-10-11-market.md section 6 (tenzen.studio):
 *
 *   Clips     every recording is a muted, inline <video> with no src in the HTML. Its poster is a
 *             <picture> under it (light or dark, chosen by the browser), so the page reads the same
 *             with scripts off. A clip gets its src when it comes within 60% of a screen of the
 *             viewport, plays once 40% of it is visible (data-play-at changes that; the hero's start
 *             sooner), and pauses when it leaves or the tab is hidden. It fades in over its poster
 *             when it starts playing.
 *   Players   .player wraps one clip (it loops) or a reel of several (one after another, with a
 *             labelled tab per clip and a thin bar that fills as it plays). A round button in the
 *             corner pauses and plays; a pause by hand sticks until the visitor plays it again.
 *   Together  (2026-10-12) a .player with data-together plays recordings made at the same moment, the
 *             PC and the phone, as one: the first keeps the clock, the others follow within a quarter
 *             second, one button pauses all. data-link-at marks, from that second on, that both show the
 *             same session (.is-linked: the rings in site.css); the stills show that moment too.
 *   Quiet     with prefers-reduced-motion, or Save-Data on, nothing loads or plays by itself: the
 *             stills stay, and the button offers Play.
 *   Theme     clips follow the page's theme (theme.js): light clips on light, dark on dark, and a
 *             theme change swaps a playing clip at the same moment in it.
 *   Reveal    blocks marked data-reveal rise 24px and fade in once as they enter (not under reduced
 *             motion). Blocks already on screen when this runs are shown at once, so nothing blinks.
 *
 * Only the page's own files are loaded (the CSP allows nothing else). No cookies, no storage.
 */
(function () {
  'use strict';

  var root = document.documentElement;
  var darkMq = window.matchMedia('(prefers-color-scheme: dark)');
  var reducedMq = window.matchMedia('(prefers-reduced-motion: reduce)');
  var saveData = Boolean(navigator.connection && navigator.connection.saveData);
  var hasIO = 'IntersectionObserver' in window;

  /** True when clips should not load or play unless the visitor asks. */
  function quiet() { return reducedMq.matches || saveData; }
  function theme() { return root.getAttribute('data-theme') === 'dark' || (!root.hasAttribute('data-theme') && darkMq.matches) ? 'dark' : 'light'; }
  function on(mq, fn) { if (mq.addEventListener) mq.addEventListener('change', fn); else if (mq.addListener) mq.addListener(fn); }

  /* ---------- clips and players ---------- */

  /** Points a video at the file for the current theme, keeping its place if it already had one. */
  function attach(video) {
    var want = video.getAttribute('data-' + theme()) || video.getAttribute('data-light');
    if (!want || video.getAttribute('data-attached') === want) return;
    var at = video.getAttribute('data-attached') ? video.currentTime : 0;
    video.setAttribute('data-attached', want);
    video.preload = 'auto';
    video.src = want;
    if (at > 0) {
      video.addEventListener('loadedmetadata', function () { try { video.currentTime = at; } catch (e) { /* not seekable yet */ } }, { once: true });
    }
  }

  var PLAY_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5.2v9.6L15 10z"/></svg>';
  var PAUSE_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.5 5h2.4v10H6.5zM11.1 5h2.4v10h-2.4z"/></svg>';

  function Player(el) {
    var self = this;
    this.el = el;
    this.clips = Array.prototype.slice.call(el.querySelectorAll('.clip'));
    this.tabs = Array.prototype.slice.call(el.querySelectorAll('[role="tab"]'));
    // Together (2026-10-12): recordings made in step (the PC and the phone at the same moment) play as one: the
    // first is the clock, the others follow it, and one button pauses them all. Otherwise several clips are a reel.
    this.together = el.hasAttribute('data-together');
    this.reel = !this.together && this.clips.length > 1;
    // The moment, in seconds, from which the PC and the phone show the same session (data-link-at): .is-linked.
    this.linkAt = parseFloat(el.getAttribute('data-link-at'));
    this.i = 0;
    this.near = false;
    this.visible = false;
    this.userPaused = false;
    this.userPlayed = false;
    this.toggle = el.querySelector('.clip-toggle');
    // How much of the player must be on screen before it plays (data-play-at; the hero's starts sooner).
    this.playAt = parseFloat(el.getAttribute('data-play-at')) || 0.4;

    this.clips.forEach(function (clip, n) {
      var v = clip.querySelector('video');
      clip.video = v;
      // iOS honours the property, not only the attribute, before it lets a clip play inline without a tap.
      v.muted = true;
      v.defaultMuted = true;
      v.playsInline = true;
      v.loop = !self.reel;
      v.addEventListener('playing', function () { clip.classList.add('is-playing'); self.sync(); });
      v.addEventListener('pause', function () { self.sync(); });
      v.addEventListener('ended', function () { if (self.reel) self.go(n + 1); });
      v.addEventListener('timeupdate', function () { self.progress(n); if (self.together && n === 0) self.follow(); });
      v.addEventListener('error', function () { clip.classList.remove('is-playing'); self.sync(); });
    });

    this.tabs.forEach(function (tab, n) {
      tab.addEventListener('click', function () {
        self.go(n);
        tab.focus();
      });
      tab.addEventListener('keydown', function (e) {
        var k = e.key;
        if (k !== 'ArrowRight' && k !== 'ArrowLeft') return;
        e.preventDefault();
        var next = (n + (k === 'ArrowRight' ? 1 : -1) + self.tabs.length) % self.tabs.length;
        self.go(next);
        self.tabs[next].focus();
      });
    });

    if (this.toggle) {
      this.toggle.hidden = false;
      this.toggle.addEventListener('click', function () { self.flip(); });
    }
    this.sync();
  }

  Player.prototype.current = function () { return this.clips[this.i]; };

  /** Whether the current clip should be playing right now. */
  Player.prototype.wanted = function () {
    return this.visible && !document.hidden && !this.userPaused && (!quiet() || this.userPlayed);
  };

  Player.prototype.update = function () {
    if (this.near && (!quiet() || this.userPlayed)) {
      if (this.together) this.clips.forEach(function (c) { attach(c.video); });
      else attach(this.current().video);
      // The next clip of a reel loads too, so the change to it does not wait on the network.
      if (this.reel) attach(this.clips[(this.i + 1) % this.clips.length].video);
    }
    if (this.wanted()) this.play(); else this.pause();
  };

  Player.prototype.play = function () {
    var vids = this.together ? this.clips.map(function (c) { return c.video; }) : [this.current().video];
    vids.forEach(function (v) {
      attach(v);
      var p = v.play();
      if (p && p.catch) p.catch(function () { /* blocked (low power mode, say): the still stays */ });
    });
  };

  /** Together: the other clips keep to the first one's clock (within a quarter second), and the link follows it. */
  Player.prototype.follow = function () {
    var clock = this.clips[0].video;
    var t = clock.currentTime;
    for (var k = 1; k < this.clips.length; k++) {
      var v = this.clips[k].video;
      if (!v.getAttribute('data-attached') || v.seeking || v.readyState < 1) continue;
      if (Math.abs(v.currentTime - t) > 0.25) { try { v.currentTime = t; } catch (e) { /* not seekable yet */ } }
      if (v.paused && !clock.paused) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
    }
    if (!isNaN(this.linkAt)) this.el.classList.toggle('is-linked', t >= this.linkAt);
  };

  Player.prototype.pause = function () {
    this.clips.forEach(function (c) { if (!c.video.paused) c.video.pause(); });
  };

  /** Shows clip n of a reel (wrapping), crossfading from the one before. */
  Player.prototype.go = function (n) {
    var count = this.clips.length;
    n = ((n % count) + count) % count;
    if (n === this.i && this.reel) { this.update(); return; }
    var old = this.current();
    this.i = n;
    var cur = this.current();
    this.clips.forEach(function (c) {
      var isCur = c === cur;
      c.classList.toggle('is-current', isCur);
      c.setAttribute('aria-hidden', isCur ? 'false' : 'true');
    });
    this.tabs.forEach(function (t, k) {
      t.setAttribute('aria-selected', k === n ? 'true' : 'false');
      t.tabIndex = k === n ? 0 : -1;
      t.style.setProperty('--p', '0');
    });
    if (old && old !== cur) {
      old.video.pause();
      try { old.video.currentTime = 0; } catch (e) { /* not loaded */ }
    }
    try { cur.video.currentTime = 0; } catch (e) { /* not loaded */ }
    this.update();
    this.sync();
  };

  /** The pause and play button: a pause by hand sticks; a play by hand works under reduced motion too. */
  Player.prototype.flip = function () {
    var v = this.current().video;
    var playing = v.getAttribute('data-attached') && !v.paused;
    if (playing) {
      this.userPaused = true;
      this.userPlayed = false;
      this.pause();
    } else {
      this.userPaused = false;
      this.userPlayed = true;
      this.near = true;
      this.visible = true;
      this.update();
    }
    this.sync();
  };

  Player.prototype.sync = function () {
    if (!this.toggle) return;
    var v = this.current().video;
    var playing = Boolean(v.getAttribute('data-attached')) && !v.paused;
    this.toggle.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
    this.toggle.setAttribute('aria-label', playing ? (this.together ? 'Pause the recordings' : 'Pause the recording') : (this.together ? 'Play the recordings' : 'Play the recording'));
    this.el.classList.toggle('is-paused', !playing);
    // The stills show the moment after the handoff, so a still pair is linked too.
    if (!isNaN(this.linkAt) && !playing) this.el.classList.add('is-linked');
  };

  Player.prototype.progress = function (n) {
    var tab = this.tabs[n];
    var v = this.clips[n].video;
    if (!tab || !v.duration) return;
    tab.style.setProperty('--p', String(Math.min(1, v.currentTime / v.duration)));
  };

  var players = Array.prototype.slice.call(document.querySelectorAll('.player')).map(function (el) {
    var p = new Player(el);
    el.__player = p;
    return p;
  });

  if (hasIO) {
    var nearIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var p = e.target.__player;
        p.near = e.isIntersecting;
        p.update();
      });
    }, { rootMargin: '60% 0px 60% 0px' });
    var seenIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var p = e.target.__player;
        if (e.intersectionRatio >= p.playAt) p.visible = true;
        else if (!e.isIntersecting || e.intersectionRatio < 0.05) p.visible = false;
        p.update();
      });
    }, { threshold: [0, 0.05, 0.12, 0.3, 0.4, 0.6] });
    players.forEach(function (p) { nearIO.observe(p.el); seenIO.observe(p.el); });
  } else {
    players.forEach(function (p) { p.near = true; p.visible = true; p.update(); });
  }

  function refreshAll() { players.forEach(function (p) { p.update(); p.sync(); }); }
  document.addEventListener('visibilitychange', refreshAll);
  on(reducedMq, refreshAll);
  // A theme change swaps each loaded clip to the other theme's file, at the same moment in it.
  on(darkMq, function () {
    window.setTimeout(function () {
      players.forEach(function (p) {
        p.clips.forEach(function (c) { if (c.video.getAttribute('data-attached')) attach(c.video); });
        p.update();
      });
    }, 0);
  });

  /* ---------- reveal on scroll ---------- */

  var blocks = Array.prototype.slice.call(document.querySelectorAll('[data-reveal]'));
  if (hasIO && !reducedMq.matches && blocks.length) {
    var revealIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('is-in');
        revealIO.unobserve(e.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
    var fold = window.innerHeight * 0.92;
    blocks.forEach(function (el) {
      if (el.getBoundingClientRect().top < fold) el.classList.add('is-in');
      else revealIO.observe(el);
    });
    root.classList.add('reveal-on');
  }

  /* ---------- the header ---------- */

  var head = document.querySelector('.site-head');
  if (head) {
    var mark = function () { head.classList.toggle('is-scrolled', window.scrollY > 8); };
    mark();
    window.addEventListener('scroll', mark, { passive: true });
  }
})();
