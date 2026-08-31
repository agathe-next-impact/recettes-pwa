/* Fonction serverless Vercel — extraction de recette depuis une URL.
   GET /api/extraire?url=https://…
   Va chercher la page côté serveur (pas de CORS), lit les données structurées
   schema.org/Recipe (JSON-LD en priorité, microdonnées/OG en repli) et renvoie
   un JSON normalisé prêt à pré-remplir le formulaire. */

const dns = require('dns').promises;
const net = require('net');
const cheerio = require('cheerio');

const ENTITES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&eacute;': 'é', '&egrave;': 'è',
  '&agrave;': 'à', '&ccedil;': 'ç', '&ecirc;': 'ê', '&ocirc;': 'ô',
  '&icirc;': 'î', '&ucirc;': 'û', '&rsquo;': '’', '&hellip;': '…'
};

function decoderEntites(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, (m) => ENTITES[m.toLowerCase()] ?? m)
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* PT1H30M → "1 h 30" ; PT45M → "45 min" */
function formaterDuree(iso) {
  if (typeof iso !== 'string') return '';
  const m = iso.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!m) return '';
  const [, j, h, min] = m.map((x) => (x ? Number(x) : 0));
  const heures = (j || 0) * 24 + (h || 0);
  if (heures && min) return `${heures} h ${String(min).padStart(2, '0')}`;
  if (heures) return `${heures} h`;
  if (min) return `${min} min`;
  return '';
}

function aplatirInstructions(instructions, resultat = []) {
  if (!instructions) return resultat;
  const liste = Array.isArray(instructions) ? instructions : [instructions];
  for (const item of liste) {
    if (typeof item === 'string') {
      const t = decoderEntites(item);
      if (t) resultat.push(t);
    } else if (item && typeof item === 'object') {
      const type = item['@type'];
      if (type === 'HowToSection' || (Array.isArray(type) && type.includes('HowToSection'))) {
        aplatirInstructions(item.itemListElement, resultat);
      } else {
        const t = decoderEntites(item.text || item.name || '');
        if (t) resultat.push(t);
      }
    }
  }
  return resultat;
}

function trouverRecette(noeud) {
  if (!noeud) return null;
  if (Array.isArray(noeud)) {
    for (const n of noeud) {
      const r = trouverRecette(n);
      if (r) return r;
    }
    return null;
  }
  if (typeof noeud !== 'object') return null;
  const type = noeud['@type'];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((t) => typeof t === 'string' && t.toLowerCase() === 'recipe')) return noeud;
  if (noeud['@graph']) return trouverRecette(noeud['@graph']);
  if (noeud.mainEntity) return trouverRecette(noeud.mainEntity);
  return null;
}

function normaliser(recette, urlSource) {
  const portionsBrut = recette.recipeYield;
  const portions = Array.isArray(portionsBrut)
    ? decoderEntites(String(portionsBrut[0]))
    : decoderEntites(String(portionsBrut ?? ''));

  const temps =
    formaterDuree(recette.totalTime) ||
    [formaterDuree(recette.prepTime), formaterDuree(recette.cookTime)]
      .filter(Boolean)
      .join(' + ');

  const ingredients = (Array.isArray(recette.recipeIngredient)
    ? recette.recipeIngredient
    : recette.recipeIngredient ? [recette.recipeIngredient] : []
  ).map(decoderEntites).filter(Boolean);

  const motsCles = decoderEntites(
    Array.isArray(recette.keywords) ? recette.keywords.join(', ') : (recette.keywords || '')
  );
  const categorie = decoderEntites(
    Array.isArray(recette.recipeCategory) ? recette.recipeCategory.join(', ') : (recette.recipeCategory || '')
  );
  const tags = [...new Set(
    `${categorie}, ${motsCles}`.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
  )].slice(0, 6);

  return {
    ok: true,
    methode: 'json-ld',
    titre: decoderEntites(recette.name || ''),
    source: urlSource,
    portions,
    temps,
    tags,
    ingredients,
    etapes: aplatirInstructions(recette.recipeInstructions),
    notes: decoderEntites(recette.description || '')
  };
}


/* ---------- Repli 2 : microdonnées schema.org (itemprop) et microformats hRecipe ----------
   Beaucoup de blogs (anciens plugins WordPress : Recipe Card, ZipList, EasyRecipe…)
   n'émettent pas de JSON-LD mais balisent la recette en HTML avec des classes
   hRecipe (fn, ingredient, instruction, preptime…) ou des attributs itemprop. */

const SELECTEURS = {
  conteneur: '[itemtype*="schema.org/Recipe" i], .hrecipe, .recipe, .easyrecipe, .wprm-recipe, .recipe-card',
  titre: '[itemprop="name"], .fn, .recipe-title, .wprm-recipe-name',
  ingredient: '[itemprop="recipeIngredient"], [itemprop="ingredients"], .ingredient, .wprm-recipe-ingredient, .ingredients li',
  etape: '[itemprop="recipeInstructions"], .instruction, .instructions li, .wprm-recipe-instruction, .preparation li',
  portions: '[itemprop="recipeYield"], .yield, .wprm-recipe-servings',
  prep: '[itemprop="prepTime"], .preptime, .wprm-recipe-prep-time',
  cuisson: '[itemprop="cookTime"], .cooktime, .wprm-recipe-cook-time',
  total: '[itemprop="totalTime"], .duration, .wprm-recipe-total-time',
  description: '[itemprop="description"], .summary, .wprm-recipe-summary'
};

function texteDe($, $racine, selecteur) {
  const el = $racine.find(selecteur).first();
  if (!el.length) return '';
  // Les durées sont souvent dans un attribut datetime/content au format ISO
  const iso = el.attr('datetime') || el.attr('content') || '';
  if (/^P/i.test(iso)) return formaterDuree(iso);
  return decoderEntites(el.text());
}

function listeDe($, $racine, selecteur) {
  const vus = new Set();
  return $racine.find(selecteur).toArray()
    .map((el) => decoderEntites($(el).text()))
    .filter((t) => {
      if (!t || t.length < 2 || t.length > 500) return false;
      if (vus.has(t)) return false;
      vus.add(t);
      return true;
    });
}

function extraireDuBalisage(html, urlSource) {
  const $ = cheerio.load(html);
  // On retire ce qui pollue : commentaires, navigation, recettes suggérées
  $('#comments, .comments, .comment, nav, header, footer, script, style, .related, .sidebar').remove();

  let $racine = $(SELECTEURS.conteneur).first();
  if (!$racine.length) $racine = $('body');

  const ingredients = listeDe($, $racine, SELECTEURS.ingredient);
  let etapes = listeDe($, $racine, SELECTEURS.etape);

  // Un seul bloc d'instructions en prose : on le découpe en phrases-étapes
  if (etapes.length === 1 && etapes[0].length > 200) {
    etapes = etapes[0].split(/(?<=[.!?])\s+(?=[A-ZÀÉÈÊÎÔÛ])/).map((s) => s.trim()).filter((s) => s.length > 10);
  }

  // Sans ingrédients identifiables, le balisage n'est pas exploitable
  if (ingredients.length < 2) return null;

  const temps = texteDe($, $racine, SELECTEURS.total)
    || [texteDe($, $racine, SELECTEURS.prep), texteDe($, $racine, SELECTEURS.cuisson)].filter(Boolean).join(' + ');

  return {
    ok: true,
    methode: 'balisage',
    titre: texteDe($, $racine, SELECTEURS.titre) || decoderEntites($('h1').first().text()),
    source: urlSource,
    portions: texteDe($, $racine, SELECTEURS.portions),
    temps,
    tags: [],
    ingredients,
    etapes,
    notes: texteDe($, $racine, SELECTEURS.description)
  };
}


/* ---------- Repli 3 : heuristique par intitulés ----------
   Dernier recours pour les blogs sans aucun balisage sémantique : on repère les
   titres « Ingrédients » / « Préparation » dans le texte et on récupère la liste
   ou les paragraphes qui suivent. Indépendant des noms de classes du thème. */

const MOTS_INGREDIENTS = /^\s*(ingr[ée]dients?|il vous faut|pour cette recette)\s*:?\s*$/i;
const MOTS_ETAPES = /^\s*(pr[ée]paration|instructions?|[ée]tapes?|r[ée]alisation|recette)\s*:?\s*$/i;
const MOTS_PORTIONS = /(pour|donne|rendement)\s*:?\s*(\d+[^.,;]{0,25}(personnes?|parts?|portions?|pi[èe]ces?))/i;
const MOTS_TEMPS = /(pr[ée]p(?:aration)?|cuisson|cook|total)\s*:?\s*((?:\d+\s*(?:h|hr|heures?|min|minutes?)\s*)+)/gi;

function collecterApres($, $depart, limite = 40) {
  const items = [];
  let $n = $depart;
  for (let i = 0; i < 12 && items.length === 0; i++) {
    $n = $n.next();
    if (!$n.length) break;
    const balise = ($n.prop('tagName') || '').toLowerCase();
    if (balise === 'ul' || balise === 'ol') {
      $n.find('li').each((_, li) => {
        const t = decoderEntites($(li).text());
        if (t && t.length > 1 && t.length < 400) items.push(t);
      });
    } else if (balise === 'p' || balise === 'div') {
      const t = decoderEntites($n.text());
      if (t && t.length > 15 && t.length < 1200) items.push(t);
    }
  }
  return items.slice(0, limite);
}

function extraireParHeuristique(html, urlSource) {
  const $ = cheerio.load(html);
  $('#comments, .comments, .comment, #respond, nav, header, footer, script, style, .related, .sidebar, aside').remove();

  let ingredients = [];
  let etapes = [];

  // On balaie tous les éléments courts susceptibles d'être un intitulé
  $('h1,h2,h3,h4,h5,h6,p,strong,b,span,div,dt').each((_, el) => {
    const t = decoderEntites($(el).text());
    if (!t || t.length > 40) return;
    if (!ingredients.length && MOTS_INGREDIENTS.test(t)) ingredients = collecterApres($, $(el));
    else if (!etapes.length && MOTS_ETAPES.test(t)) etapes = collecterApres($, $(el));
  });

  if (ingredients.length < 2) return null;

  // À défaut de section « Préparation », on prend les paragraphes substantiels du corps
  if (!etapes.length) {
    etapes = $('article p, .entry-content p, .post-content p, main p').toArray()
      .map((el) => decoderEntites($(el).text()))
      .filter((t) => t.length > 40 && t.length < 1200)
      .slice(0, 25);
  }

  const texteGlobal = decoderEntites($('body').text()).slice(0, 6000);
  const portions = (texteGlobal.match(MOTS_PORTIONS) || [])[2] || '';
  const temps = [...texteGlobal.matchAll(MOTS_TEMPS)]
    .map((m) => `${m[1].toLowerCase().startsWith('cuisson') || m[1].toLowerCase() === 'cook' ? 'cuisson' : 'prép.'} ${m[2].trim()}`)
    .slice(0, 2).join(' + ');

  return {
    ok: true,
    methode: 'heuristique',
    approximatif: true,
    titre: decoderEntites($('h1').first().text()) || decoderEntites($('title').first().text()),
    source: urlSource,
    portions: portions.trim(),
    temps,
    tags: [],
    ingredients,
    etapes,
    notes: ''
  };
}

/* Repli minimal quand aucun JSON-LD Recipe n'est présent : balises Open Graph. */
function replisOpenGraph(html, urlSource) {
  const og = (prop) => {
    const m = html.match(new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${prop}["']`, 'i'));
    return m ? decoderEntites(m[1]) : '';
  };
  const titre = og('title') || decoderEntites((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  if (!titre) return null;
  return {
    ok: true, partiel: true,
    titre, source: urlSource,
    portions: '', temps: '', tags: [], ingredients: [], etapes: [],
    notes: og('description')
  };
}

async function verifierHoteAutorise(hostname) {
  if (net.isIP(hostname)) throw new Error('adresse IP directe refusée');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(hostname)) throw new Error('hôte local refusé');
  const { address } = await dns.lookup(hostname);
  const prive = /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(address)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(address)
    || address === '::1' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80');
  if (prive) throw new Error('adresse privée refusée');
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
  try {
    const urlBrute = req.query.url;
    if (!urlBrute) return res.status(400).json({ ok: false, erreur: 'Paramètre url manquant.' });

    let url;
    try {
      url = new URL(urlBrute);
      if (!/^https?:$/.test(url.protocol)) throw new Error();
    } catch {
      return res.status(400).json({ ok: false, erreur: 'URL invalide.' });
    }
    await verifierHoteAutorise(url.hostname);

    const controleur = new AbortController();
    const minuterie = setTimeout(() => controleur.abort(), 8000);
    const reponse = await fetch(url.href, {
      signal: controleur.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CarnetRecettes/1.0; +https://recettes-pwa-one.vercel.app)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5'
      }
    });
    clearTimeout(minuterie);

    if (!reponse.ok) {
      return res.status(502).json({ ok: false, erreur: `Le site a répondu ${reponse.status}.` });
    }
    const html = (await reponse.text()).slice(0, 2_000_000);

    // Tous les blocs <script type="application/ld+json">
    const blocs = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    for (const [, contenu] of blocs) {
      try {
        const donnees = JSON.parse(contenu.trim());
        const recette = trouverRecette(donnees);
        if (recette) return res.status(200).json(normaliser(recette, url.href));
      } catch { /* bloc JSON-LD malformé : on passe au suivant */ }
    }

    // Repli 2 : microdonnées / hRecipe
    try {
      const parBalisage = extraireDuBalisage(html, url.href);
      if (parBalisage) return res.status(200).json(parBalisage);
    } catch { /* balisage inexploitable : on tente Open Graph */ }

    // Repli 3 : heuristique par intitulés
    try {
      const parHeuristique = extraireParHeuristique(html, url.href);
      if (parHeuristique) return res.status(200).json(parHeuristique);
    } catch { /* on tente Open Graph */ }

    const repli = replisOpenGraph(html, url.href);
    if (repli) return res.status(200).json(repli);

    return res.status(404).json({
      ok: false,
      erreur: 'Aucune recette structurée trouvée sur cette page.'
    });
  } catch (e) {
    const message = e.name === 'AbortError'
      ? 'Le site met trop de temps à répondre.'
      : 'Impossible de récupérer cette page.';
    return res.status(502).json({ ok: false, erreur: message });
  }
};
