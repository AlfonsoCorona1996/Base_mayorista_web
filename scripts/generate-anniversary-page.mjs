import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Genera `aniversario.html` a partir del index.html ya compilado.
 *
 * La app es una SPA sin SSR: los bots de vista previa (WhatsApp, Facebook)
 * no ejecutan JavaScript y solo leen el HTML. Cloudflare Pages sirve
 * `aniversario.html` en la URL `/aniversario`, así que este archivo lleva los
 * metadatos Open Graph de la campaña y arranca la misma app Angular, que
 * resuelve la ruta `aniversario`.
 *
 * Además adapta el arranque a teléfonos modestos: muestra la bienvenida
 * estática (welcome.static.html) mientras carga la app, precarga el chunk de
 * la encuesta para no esperarlo en cascada, no fuerza la fuente de iconos del
 * panel y no anuncia el manifest de la PWA administrativa.
 */

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FEATURE_DIR = join(WORKSPACE, "src", "app", "features", "public", "anniversary-survey");
const DEFAULT_SITE_URL = "https://www.base-mayorista.com";
const TITLE = "Encuesta de aniversario | Base Mayorista";
const SHARE_TITLE = "¡Cumplimos un año y el regalo es para ti!";
const DESCRIPTION =
  "Responde nuestra encuesta de aniversario y registra tu regalo especial. 6 preguntas. Aproximadamente 2 minutos.";
const THEME_COLOR = "#fff8f1";

function escapeAttribute(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function replaceOnce(html, pattern, replacement, label) {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const matches = html.match(global);
  if (!matches || matches.length !== 1) {
    throw new Error(`[aniversario] No se encontró exactamente una coincidencia para: ${label}`);
  }
  return html.replace(pattern, () => replacement);
}

function removeAll(html, pattern, label) {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  if (!global.test(html)) throw new Error(`[aniversario] No se encontró: ${label}`);
  return html.replace(global, "");
}

function normalizeText(value) {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** La bienvenida estática no debe desviarse del texto real de la encuesta. */
export function loadStaticWelcome(featureDir = FEATURE_DIR) {
  const partial = readFileSync(join(featureDir, "welcome.static.html"), "utf8").replace(/^\s*<!--[\s\S]*?-->\s*/, "");
  const template = normalizeText(readFileSync(join(featureDir, "anniversary-survey.html"), "utf8")) + " " +
    readFileSync(join(featureDir, "survey-definition.ts"), "utf8");
  const synced = [...partial.matchAll(/<([a-z]+)[^>]*\bdata-sync\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => normalizeText(m[2]));
  if (synced.length < 5) throw new Error("[aniversario] welcome.static.html perdió sus marcas data-sync.");
  const missing = synced.filter((text) => !template.includes(text));
  if (missing.length) {
    throw new Error(`[aniversario] La bienvenida estática no coincide con anniversary-survey.html: ${missing.join(" | ")}`);
  }
  return partial;
}

/** Chunks del componente de la encuesta (y sus imports estáticos) que index.html no precarga ya. */
export function findSurveyChunks(browserOutputDir, indexHtml) {
  const files = readdirSync(browserOutputDir).filter((name) => /^chunk-[A-Z0-9]+\.js$/.test(name));
  const entry = files.find((name) => readFileSync(join(browserOutputDir, name), "utf8").includes('"app-anniversary-survey"'));
  if (!entry) throw new Error("[aniversario] No se encontró el chunk del componente de la encuesta.");
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const code = readFileSync(join(browserOutputDir, name), "utf8");
    for (const match of code.matchAll(/(?:from|import)\s*"\.\/(chunk-[A-Z0-9]+\.js)"/g)) visit(match[1]);
  };
  visit(entry);
  return [...seen].filter((name) => !indexHtml.includes(`href="${name}"`));
}

export function buildAnniversaryHtml(indexHtml, siteUrl = DEFAULT_SITE_URL, { staticWelcome = "", preloadChunks = [] } = {}) {
  const base = siteUrl.replace(/\/+$/, "");
  const pageUrl = `${base}/aniversario`;
  const imageUrl = `${base}/aniversario/og-aniversario.jpg`;
  const head = [
    `<link rel="canonical" href="${pageUrl}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Base Mayorista">`,
    `<meta property="og:locale" content="es_MX">`,
    `<meta property="og:url" content="${pageUrl}">`,
    `<meta property="og:title" content="${escapeAttribute(SHARE_TITLE)}">`,
    `<meta property="og:description" content="${escapeAttribute(DESCRIPTION)}">`,
    `<meta property="og:image" content="${imageUrl}">`,
    `<meta property="og:image:secure_url" content="${imageUrl}">`,
    `<meta property="og:image:type" content="image/jpeg">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="Logo de Base Mayorista con el mensaje: ¡Cumplimos un año y el regalo es para ti!">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeAttribute(SHARE_TITLE)}">`,
    `<meta name="twitter:description" content="${escapeAttribute(DESCRIPTION)}">`,
    `<meta name="twitter:image" content="${imageUrl}">`,
    `<link rel="icon" type="image/png" sizes="32x32" href="/aniversario/icon-32.png">`,
    `<link rel="apple-touch-icon" sizes="180x180" href="/aniversario/icon-180.png">`,
    `<link rel="preload" as="image" href="/aniversario/bm-logo.webp" type="image/webp" fetchpriority="high">`,
    ...preloadChunks.map((name) => `<link rel="modulepreload" href="${name}">`),
  ].join("\n  ");

  let html = indexHtml;
  // Favicon e ícono de inicio con el logo de la campaña en lugar de los del panel.
  html = removeAll(html, /\s*<link rel="(?:apple-touch-icon|icon)"[^>]*>/, "íconos del panel");
  html = replaceOnce(html, /<title>[^<]*<\/title>/, `<title>${TITLE}</title>`, "title");
  html = replaceOnce(
    html,
    /<meta name="viewport" content="[^"]*">/,
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">`,
    "viewport",
  );
  html = replaceOnce(
    html,
    /<meta name="description" content="[^"]*">/,
    `<meta name="description" content="${escapeAttribute(DESCRIPTION)}">\n  ${head}`,
    "description",
  );
  html = replaceOnce(html, /<meta name="theme-color" content="[^"]*">/, `<meta name="theme-color" content="${THEME_COLOR}">`, "theme-color");
  // La encuesta no usa la fuente de iconos: ni se fuerza su descarga ni se declara.
  html = replaceOnce(
    html,
    /<script>\s*document\.documentElement\.classList\.add\("ms-icons-loading"\);[\s\S]*?<\/script>/,
    "",
    "ms-icons-loading script",
  );
  html = replaceOnce(
    html,
    /<style>(?:(?!<\/style>)[\s\S])*Material Symbols Rounded(?:(?!<\/style>)[\s\S])*<\/style>/,
    "",
    "Material Symbols @font-face",
  );
  // La encuesta usa fuentes del sistema: no hace falta declarar Inter.
  html = replaceOnce(html, /<style>@font-face\{font-family:Inter[\s\S]*?<\/style>/, "", "Inter @font-face");
  // El manifest es de la PWA administrativa; no debe ofrecerse a las clientas.
  html = replaceOnce(html, /\s*<link rel="manifest" href="manifest\.webmanifest">/, "", "manifest");
  html = replaceOnce(html, /<div id="app-shell-skeleton"[\s\S]*?(?=<noscript>)/, `${staticWelcome}\n  `, "app-shell-skeleton");
  return html;
}

export function generateAnniversaryPage(browserOutputDir, siteUrl = process.env.PUBLIC_SITE_URL || DEFAULT_SITE_URL) {
  const indexHtml = readFileSync(join(browserOutputDir, "index.html"), "utf8");
  const outputPath = join(browserOutputDir, "aniversario.html");
  const html = buildAnniversaryHtml(indexHtml, siteUrl, {
    staticWelcome: loadStaticWelcome(),
    preloadChunks: findSurveyChunks(browserOutputDir, indexHtml),
  });
  writeFileSync(outputPath, html, "utf8");
  return outputPath;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("Uso: node scripts/generate-anniversary-page.mjs <carpeta-browser-del-build>");
    process.exit(1);
  }
  console.log(`Generado: ${generateAnniversaryPage(resolve(dir))}`);
}
