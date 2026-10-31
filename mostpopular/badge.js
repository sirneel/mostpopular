// @ts-check
/**
 * MostPopular.com — dynamic SVG rank badge (pure functions, no DOM needed).
 * Runs in the browser, a Cloudflare Worker, or Node, so the same code can
 * serve `/badge/{slug}.svg` or render inline.
 *
 * NOTE: SVGs loaded through <img> cannot fetch remote images, so the avatar
 * must be passed as a data: URI (png/jpeg/webp). Otherwise initials are drawn.
 */

/**
 * @typedef {Object} BadgeInput
 * @property {string} name
 * @property {number} rank
 * @property {string} [category]      e.g. "creator"
 * @property {string} place           e.g. "South Africa" or "Worldwide"
 * @property {boolean} [verified]
 * @property {string} [avatarDataUri] data:image/(png|jpeg|webp);base64,...
 * @property {'dark'|'light'} [theme]
 */

const THEMES = {
  dark:  { bg: '#0F172A', border: '#1E293B', fg: '#F8FAFC', muted: '#94A3B8', accent: '#FBBF24', verified: '#38BDF8' },
  light: { bg: '#FFFFFF', border: '#E2E8F0', fg: '#0F172A', muted: '#64748B', accent: '#D97706', verified: '#0284C7' },
};
const FONT = "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";
const AVATAR_RE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

/** @param {unknown} s */
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
/** @param {string} s @param {number} n */
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
/** @param {string} s */
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
/** FNV-1a 32-bit. @param {string} str */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
/** @param {number} r */
const formatRank = (r) =>
  r < 1000 ? `#${r}` : r < 1e6 ? `#${(r / 1000).toFixed(r < 10000 ? 1 : 0)}K` : `#${(r / 1e6).toFixed(1)}M`;
/** @param {string} name */
function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const out = (parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '');
  return out.toUpperCase();
}

/**
 * Render the badge as a standalone SVG string (360×96, scales freely).
 * @param {BadgeInput} input
 * @returns {string}
 */
export function renderBadgeSVG(input) {
  const t = THEMES[input.theme === 'light' ? 'light' : 'dark'];
  const rank = Math.max(1, Math.floor(Number(input.rank) || 1));
  const rawName = String(input.name || 'Unknown').trim() || 'Unknown';
  const name = clip(rawName, 19);
  const category = cap(String(input.category || '').trim());
  const place = String(input.place || '').trim();
  const label = clip([category, place].filter(Boolean).join(' · '), 30);
  const ariaPlace = place === 'Worldwide' ? 'Worldwide' : `in ${place}`;
  const aria = `${formatRank(rank)} ${category ? category + ' ' : ''}${ariaPlace} — ${rawName}${input.verified ? ' (verified)' : ''}`.replace(/\s+/g, ' ');
  const uid = 'mp' + hash(`${rawName}|${rank}|${label}`).toString(36);
  const ring = rank <= 10 ? t.accent : t.border;

  const avatar =
    input.avatarDataUri && AVATAR_RE.test(input.avatarDataUri)
      ? `<image href="${input.avatarDataUri}" x="16" y="16" width="64" height="64" clip-path="url(#${uid}c)" preserveAspectRatio="xMidYMid slice"/>`
      : `<circle cx="48" cy="48" r="32" fill="hsl(${hash(rawName) % 360} 55% 45%)"/>` +
        `<text x="48" y="56" text-anchor="middle" font-family="${FONT}" font-size="22" font-weight="700" fill="#fff">${esc(initials(rawName))}</text>`;

  const tick = input.verified
    ? `<circle cx="73" cy="73" r="11" fill="${t.verified}" stroke="${t.bg}" stroke-width="3"/>` +
      `<path d="M68 73.5l3.5 3.5 7-7.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`
    : '';

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="96" viewBox="0 0 360 96" role="img" aria-labelledby="${uid}t">` +
    `<title id="${uid}t">${esc(aria)}</title>` +
    `<defs><clipPath id="${uid}c"><circle cx="48" cy="48" r="32"/></clipPath></defs>` +
    `<rect x=".5" y=".5" width="359" height="95" rx="16" fill="${t.bg}" stroke="${t.border}"/>` +
    avatar +
    `<circle cx="48" cy="48" r="32" fill="none" stroke="${ring}" stroke-width="2"/>` +
    tick +
    `<text x="100" y="28" font-family="${FONT}" font-size="15" font-weight="700" fill="${t.fg}">${esc(name)}</text>` +
    `<text x="344" y="26" text-anchor="end" font-family="${FONT}" font-size="9" font-weight="700" letter-spacing="1.2" fill="${t.muted}">MOSTPOPULAR</text>` +
    `<text x="100" y="62" font-family="${FONT}" font-size="32" font-weight="800" fill="${t.accent}">${esc(formatRank(rank))}</text>` +
    `<text x="100" y="82" font-family="${FONT}" font-size="12" fill="${t.muted}">${esc(label)}</text>` +
    `</svg>`
  );
}

/** @param {string} svg */
export const svgToDataUri = (svg) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

/**
 * Copy-paste embed snippets for bios, blogs and READMEs.
 * @param {{ svgUrl: string, profileUrl: string, alt?: string }} o
 * @returns {{ html: string, markdown: string }}
 */
export function badgeEmbedCode({ svgUrl, profileUrl, alt = 'MostPopular ranking badge' }) {
  return {
    html: `<a href="${esc(profileUrl)}" target="_blank" rel="noopener"><img src="${esc(svgUrl)}" width="360" height="96" alt="${esc(alt)}"></a>`,
    markdown: `[![${alt.replace(/[[\]]/g, '')}](${svgUrl})](${profileUrl})`,
  };
}

/** @param {string} code ISO 3166-1 alpha-2 */
function regionName(code) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Map a `figures` row + `figure_ranks()` result to badge input.
 * @param {{ display_name: string, category: string, country_code: string, verified: boolean }} figure
 * @param {{ global_rank: number, country_rank: number, category_country_rank: number }} ranks
 * @param {{ scope?: 'category_country'|'country'|'global', avatarDataUri?: string, theme?: 'dark'|'light' }} [opts]
 * @returns {BadgeInput}
 */
export function badgeInputFromRows(figure, ranks, { scope = 'category_country', avatarDataUri, theme } = {}) {
  const rank =
    scope === 'global' ? ranks.global_rank : scope === 'country' ? ranks.country_rank : ranks.category_country_rank;
  return {
    name: figure.display_name,
    rank,
    category: scope === 'category_country' ? figure.category : '',
    place: scope === 'global' ? 'Worldwide' : regionName(figure.country_code),
    verified: figure.verified,
    avatarDataUri,
    theme,
  };
}

/*
 * Usage:
 *   const { data: ranks } = await supabase.rpc('figure_ranks', { p_figure: id }).single();
 *   const svg = renderBadgeSVG(badgeInputFromRows(figure, ranks, { theme: 'dark' }));
 *   el.innerHTML = svg;                       // inline
 *   img.src = svgToDataUri(svg);              // or as <img>
 */
