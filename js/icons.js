/**
 * The icon set — all of it, in one place.
 *
 * WHY NOT EMOJI
 * -------------
 * Emoji were never designed together. Apple, Google, Samsung and Windows
 * each draw them differently, so the same screen looked like a different
 * product on every phone in the building, and none of the drawings had
 * anything to do with a design system built on ink borders and flat
 * fills. These are drawn here, so they look the same everywhere and they
 * look like the rest of the application.
 *
 * THE STYLE
 * ---------
 * Geometric, heavy-outlined, flat-filled. Every icon is a 24x24 box with
 * a 2px outline and one or two solid fills, no gradients and no detail
 * that disappears below 20px.
 *
 * COLOUR
 * ------
 * The outline is `currentColor`, so an icon inherits the ink of whatever
 * it sits in: black on paper, cream in dark mode, black again on a yellow
 * button. The fills come from design tokens. An icon never picks a hex
 * code, exactly like every other part of the system.
 *
 * TO ADD ONE
 * ----------
 * Add an entry to ICONS below. Then either write `data-icon="yourname"`
 * on a span in the HTML, or call `icon('yourname')` inside a template.
 * An unknown name renders nothing rather than a broken glyph.
 *
 * TO RECOLOUR ONE
 * ---------------
 * Change the var() in its entry, or override `--ic` on an ancestor in
 * CSS — every fill that should follow its surroundings reads `--ic`.
 */

/* Shorthands, so the table below stays readable.
 *
 * Every solid shape is `var(--ic, <its own colour>)` and every cut-out
 * detail inside one is `--ic2`. That is what lets an icon survive being
 * dropped onto a filled control: a yellow wrench on a yellow nav tab
 * would be invisible, so those contexts set --ic to the paper colour and
 * --ic2 back to the ground. One rule in main.css, no per-icon special
 * cases, and an icon used somewhere nobody anticipated still keeps its
 * own colours because the var() fallback is its default. */
const INK = 'currentColor';
const ic  = d => `var(--ic, ${d})`;          // the solid body
const W   = 'var(--ic2, var(--surface))';    // a cut-out inside the body
const Y = ic('var(--accent)');
const G = ic('var(--ok-fill)');
const B = ic('var(--info-fill)');
const O = ic('var(--urgent-fill)');
const R = ic('var(--danger-fill)');
const K = ic('var(--critical-fill)');
const M = ic('var(--muted-fill)');

/**
 * Each entry is the inside of the <svg>. The wrapper, the viewBox, the
 * stroke width and the accessibility attributes are added once, below.
 */
export const ICONS = Object.freeze({

  /* ---- Place and movement ------------------------------------------ */
  pin: `<path d="M12 22c0 0 7-7.4 7-12.2A7 7 0 0 0 5 9.8C5 14.6 12 22 12 22Z" fill="${R}"/>
        <circle cx="12" cy="9.6" r="2.7" fill="${W}"/>`,

  building: `<rect x="4" y="3" width="16" height="18" fill="${B}"/>
             <rect x="7"  y="6.5" width="3.5" height="3.5" fill="${W}"/>
             <rect x="13.5" y="6.5" width="3.5" height="3.5" fill="${W}"/>
             <rect x="7"  y="12" width="3.5" height="3.5" fill="${W}"/>
             <rect x="13.5" y="12" width="3.5" height="3.5" fill="${W}"/>
             <rect x="10" y="17.5" width="4" height="3.5" fill="${W}"/>`,

  walk: `<circle cx="13" cy="4.5" r="2.5" fill="${Y}"/>
         <path d="M13 8l-3 4 2 3-1 5" fill="none"/>
         <path d="M12 15l3.5 2.5" fill="none"/>
         <path d="M10 12L6.5 14" fill="none"/>`,

  car: `<path d="M3.5 17.5V13l2.3-5.5h12.4L20.5 13v4.5z" fill="${Y}"/>
        <path d="M6.5 13h11" fill="none"/>
        <circle cx="7.6" cy="17.5" r="2.3" fill="${W}"/>
        <circle cx="16.4" cy="17.5" r="2.3" fill="${W}"/>`,

  compass: `<circle cx="12" cy="12" r="9" fill="${B}"/>
            <path d="M16.5 7.5 13.8 13.8 7.5 16.5 10.2 10.2Z" fill="${W}"/>`,

  /* ---- Work --------------------------------------------------------- */
  wrench: `<path d="M20 5.5 16.5 9 15 7.5 18.5 4a5.2 5.2 0 0 0-6.8 6.6l-6.6 6.6a2.1 2.1 0 1 0 3 3l6.6-6.6A5.2 5.2 0 0 0 20 5.5Z" fill="${Y}"/>`,

  toolbox: `<rect x="3" y="9" width="18" height="11" fill="${Y}"/>
            <path d="M9 9V6.5h6V9" fill="none"/>
            <path d="M3 13.5h18" fill="none"/>
            <rect x="10.5" y="11.5" width="3" height="4" fill="${W}"/>`,

  clipboard: `<rect x="5" y="4" width="14" height="17" fill="${G}"/>
              <rect x="9" y="2" width="6" height="4" fill="${W}"/>
              <path d="M8.5 11h7M8.5 15h7" fill="none"/>`,

  inbox: `<path d="M4 13 6 4h12l2 9v7H4z" fill="${B}"/>
          <path d="M4 13h4l1.2 2.2h5.6L16 13h4" fill="none"/>`,

  files: `<path d="M3 7h6l2 2.5h10V20H3z" fill="${Y}"/>
          <path d="M3 11.5h18" fill="none"/>`,

  note: `<rect x="4" y="3" width="16" height="18" fill="${G}"/>
         <path d="M8 8h8M8 12h8M8 16h5" fill="none"/>`,

  /* ---- Measurement and reporting ------------------------------------ */
  dashboard: `<rect x="3" y="11" width="4.5" height="9" fill="${Y}"/>
              <rect x="9.75" y="6" width="4.5" height="14" fill="${G}"/>
              <rect x="16.5" y="3" width="4.5" height="17" fill="${B}"/>`,

  chart: `<path d="M3.5 20h17" fill="none"/>
          <path d="M5 16.5 10 11l3.5 2.5L19 6" fill="none"/>
          <circle cx="19" cy="6" r="2.4" fill="${Y}"/>`,

  clock: `<circle cx="12" cy="12" r="9" fill="${Y}"/>
          <path d="M12 6.5V12l3.5 2.5" fill="none"/>`,

  hourglass: `<path d="M6.5 3h11v3.5L12 12l5.5 5.5V21h-11v-3.5L12 12 6.5 6.5Z" fill="${Y}"/>`,

  alarm: `<circle cx="12" cy="13.5" r="7.5" fill="${O}"/>
          <path d="M12 9v4.5l3 2" fill="none"/>
          <path d="M4.5 4.5 7 6.8M19.5 4.5 17 6.8" fill="none"/>`,

  /* ---- People and admin --------------------------------------------- */
  users: `<circle cx="8.5" cy="8" r="3.5" fill="${Y}"/>
          <path d="M2.5 20c0-3.3 2.7-6 6-6s6 2.7 6 6Z" fill="${Y}"/>
          <circle cx="17" cy="9" r="2.8" fill="${W}"/>
          <path d="M14 20h7.5v-.8c0-2.6-1.9-4.7-4.5-4.7-.6 0-1.2.1-1.7.3" fill="${W}"/>`,

  gear: `<g fill="${B}">
           <rect x="10.2" y="1.8" width="3.6" height="20.4"/>
           <rect x="1.8" y="10.2" width="20.4" height="3.6"/>
           <rect x="10.2" y="1.8" width="3.6" height="20.4" transform="rotate(45 12 12)"/>
           <rect x="1.8" y="10.2" width="20.4" height="3.6" transform="rotate(45 12 12)"/>
         </g>
         <circle cx="12" cy="12" r="7.5" fill="${B}"/>
         <circle cx="12" cy="12" r="3.2" fill="${W}"/>`,

  eye: `<path d="M2.5 12S6.5 6 12 6s9.5 6 9.5 6-4 6-9.5 6-9.5-6-9.5-6Z" fill="${G}"/>
        <circle cx="12" cy="12" r="3.4" fill="${B}"/>`,

  /* ---- Alerts and channels ------------------------------------------ */
  bell: `<path d="M6 17.5V11a6 6 0 0 1 12 0v6.5l1.8 2H4.2Z" fill="${Y}"/>
         <path d="M10 20.5a2 2 0 0 0 4 0" fill="none"/>`,

  bellOff: `<path d="M6 17.5V11a6 6 0 0 1 12 0v6.5l1.8 2H4.2Z" fill="${M}"/>
            <path d="M4 4l16 16" fill="none"/>`,

  siren: `<path d="M5 19v-3a7 7 0 0 1 14 0v3z" fill="${K}"/>
          <rect x="3" y="19" width="18" height="2.6" fill="${K}"/>
          <path d="M12 2v2.5M4 6l1.8 1.5M20 6l-1.8 1.5" fill="none"/>`,

  warning: `<path d="M12 3 22 20.5H2Z" fill="${O}"/>
            <path d="M12 9.5v4.5" fill="none"/>
            <rect x="10.8" y="16" width="2.4" height="2.4" fill="${INK}" stroke="none"/>`,

  chat: `<path d="M3 4.5h18v11h-11l-5 4v-4H3Z" fill="${G}"/>
         <circle cx="8.5" cy="10" r="1.2" fill="${INK}" stroke="none"/>
         <circle cx="12" cy="10" r="1.2" fill="${INK}" stroke="none"/>
         <circle cx="15.5" cy="10" r="1.2" fill="${INK}" stroke="none"/>`,

  phone: `<path d="M6 3h3.5l2 5-2.6 1.8a12.5 12.5 0 0 0 5.3 5.3L16 12.5l5 2V18c0 1.6-1.4 3-3 3A15 15 0 0 1 3 6c0-1.6 1.4-3 3-3Z" fill="${Y}"/>`,

  mobile: `<rect x="7" y="2" width="10" height="20" fill="${B}"/>
           <path d="M10.3 19h3.4" fill="none"/>`,

  mailbox: `<rect x="3" y="8" width="18" height="12" fill="${M}"/>
            <path d="M3 8l9 6 9-6" fill="none"/>`,

  /* ---- Outcomes ------------------------------------------------------ */
  check: `<circle cx="12" cy="12" r="9" fill="${G}"/>
          <path d="M7.5 12.3 10.5 15.3 16.5 8.8" fill="none" stroke="${W}" stroke-width="2.6"/>`,

  thumbUp: `<path d="M7 10.5 11 3c1.6 0 2.5 1 2.5 2.5V9H19c1.1 0 2 .9 1.8 2l-1.3 7c-.2 1.1-1 2-2.1 2H7Z" fill="${Y}"/>
            <rect x="2.8" y="10.5" width="4.2" height="9.5" fill="${W}"/>`,

  ban: `<circle cx="12" cy="12" r="9" fill="${R}"/>
        <path d="M5.8 5.8 18.2 18.2" fill="none" stroke="${W}" stroke-width="2.6"/>`,

  pause: `<circle cx="12" cy="12" r="9" fill="${O}"/>
          <rect x="9" y="8" width="2.2" height="8" fill="${W}" stroke="none"/>
          <rect x="12.8" y="8" width="2.2" height="8" fill="${W}" stroke="none"/>`,

  party: `<path d="M3 21 9 8l7 7Z" fill="${Y}"/>
          <path d="M14 3.5v2.5M19 6l-1.8 1.8M20.5 11.5H18" fill="none"/>
          <circle cx="16.5" cy="3.5" r="1.3" fill="${R}" stroke="none"/>
          <circle cx="21" cy="7.5" r="1.3" fill="${G}" stroke="none"/>`,

  /* ---- Comfort ------------------------------------------------------- */
  coffee: `<path d="M4 8h13v7a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5Z" fill="${Y}"/>
           <path d="M17 10h2.2a2.4 2.4 0 0 1 0 4.8H17" fill="none"/>
           <path d="M8 2.5v2.5M12 2.5v2.5" fill="none"/>`,

  /* The offline page. A satellite dish is unreadable at this size, and
     "no signal" is what the page is actually saying. */
  offline: `<path d="M2.5 8.5a15 15 0 0 1 19 0" fill="none"/>
            <path d="M6 12.4a10 10 0 0 1 12 0" fill="none"/>
            <path d="M9.4 16.1a5 5 0 0 1 5.2 0" fill="none"/>
            <circle cx="12" cy="19.6" r="1.9" fill="${B}"/>
            <path d="M3.5 3.5 20.5 20.5" fill="none" stroke-width="2.6"/>`,

  /* ---- Theme --------------------------------------------------------- */
  moon: `<path d="M20.5 14.8A8.6 8.6 0 0 1 9.2 3.5a8.9 8.9 0 1 0 11.3 11.3Z" fill="${B}"/>`,

  sun: `<circle cx="12" cy="12" r="5" fill="${Y}"/>
        <path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M19.4 4.6l-2.1 2.1M6.7 17.3l-2.1 2.1" fill="none"/>`,

  /* ---- Plain marks ---------------------------------------------------- */
  close: `<path d="M5.5 5.5 18.5 18.5M18.5 5.5 5.5 18.5" fill="none" stroke-width="2.8"/>`,

  caretUp:   `<path d="M12 7 20 17H4Z" fill="${INK}"/>`,
  caretDown: `<path d="M12 17 4 7h16Z" fill="${INK}"/>`,

  /* Directional: mirrored for Arabic by the .icon-flip rule in main.css. */
  next: `<path d="M4 5 15 12 4 19Z" fill="${Y}"/>
         <rect x="17" y="4.5" width="3" height="15" fill="${INK}" stroke="none"/>`,

  /**
   * The state marker. A filled square rather than a coloured bead: it is
   * the smallest thing on the screen and a square survives being small.
   * Colour comes from --ic, which every tone sets.
   */
  dot: `<rect x="4" y="4" width="16" height="16" fill="${M}"/>`
});

/** Directional icons, which have to mirror in Arabic. */
const FLIPPED = new Set(['next', 'walk', 'phone']);

/**
 * One icon as markup.
 * @param {string} name  a key of ICONS
 * @param {{tone?: string, cls?: string}} [opts]
 *        tone - a token name such as 'danger-fill', used by `dot`
 *        cls  - extra classes on the <svg>
 */
export function icon(name, opts = {}) {
  const body = ICONS[name];
  if (!body) return '';                 // unknown: draw nothing, break nothing

  const classes = ['icon'];
  if (FLIPPED.has(name)) classes.push('icon-flip');
  if (opts.cls) classes.push(opts.cls);

  const style = opts.tone ? ` style="--ic:var(--${opts.tone})"` : '';

  return `<svg class="${classes.join(' ')}" viewBox="0 0 24 24" width="1em" height="1em"` +
         ` fill="none" stroke="currentColor" stroke-width="2"` +
         ` stroke-linejoin="round" stroke-linecap="round"` +
         ` aria-hidden="true" focusable="false"${style}>${body}</svg>`;
}

/** A square state marker in a given tone, e.g. tone('danger-fill'). */
export const toneDot = tone => icon('dot', { tone });

/**
 * Fills in every `data-icon="name"` in the page. The static HTML carries
 * the name rather than the drawing, so the markup stays readable and the
 * set stays in one file. Safe to call again after a re-render.
 */
export function paintIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(node => {
    const markup = icon(node.dataset.icon, { tone: node.dataset.iconTone });
    if (markup) node.innerHTML = markup;
  });
}
