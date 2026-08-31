/* Fonction serverless Vercel — extraction de recette depuis une URL.
   GET /api/extraire?url=https://…
   Va chercher la page côté serveur (pas de CORS), lit les données structurées
   schema.org/Recipe (JSON-LD en priorité, microdonnées/OG en repli) et renvoie
   un JSON normalisé prêt à pré-remplir le formulaire. */

const dns = require('dns').promises;
const net = require('net');

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
