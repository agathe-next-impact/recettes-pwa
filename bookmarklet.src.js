/* Marque-page « Envoyer au carnet » — source lisible.
   S'exécute dans VOTRE navigateur, sur la page que vous consultez déjà.
   Aucune requête automatisée : rien à bloquer. Fonctionne aussi sur les sites
   qui rendent la recette en JavaScript, puisqu'on lit le DOM final.
   La version minifiée est intégrée dans index.html. */
(function () {
  var APP = 'https://recettes-pwa-one.vercel.app/';

  function txt(v) {
    if (v == null) return '';
    var d = document.createElement('div');
    d.innerHTML = String(v);
    return (d.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function duree(iso) {
    if (typeof iso !== 'string') return '';
    var m = iso.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i);
    if (!m) return '';
    var h = (+(m[1] || 0)) * 24 + (+(m[2] || 0)), mn = +(m[3] || 0);
    if (h && mn) return h + ' h ' + (mn < 10 ? '0' : '') + mn;
    if (h) return h + ' h';
    return mn ? mn + ' min' : '';
  }

  function etapes(x, out) {
    out = out || [];
    if (!x) return out;
    (Array.isArray(x) ? x : [x]).forEach(function (i) {
      if (typeof i === 'string') { var t = txt(i); if (t) out.push(t); }
      else if (i && typeof i === 'object') {
        var ty = i['@type'];
        if (ty === 'HowToSection' || (Array.isArray(ty) && ty.indexOf('HowToSection') > -1)) etapes(i.itemListElement, out);
        else { var s = txt(i.text || i.name); if (s) out.push(s); }
      }
    });
    return out;
  }

  function chercher(n) {
    if (!n) return null;
    if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) { var r = chercher(n[i]); if (r) return r; } return null; }
    if (typeof n !== 'object') return null;
    var t = n['@type'], a = Array.isArray(t) ? t : [t];
    for (var j = 0; j < a.length; j++) if (typeof a[j] === 'string' && a[j].toLowerCase() === 'recipe') return n;
    return chercher(n['@graph']) || chercher(n.mainEntity);
  }

  /* 1. JSON-LD présent dans le DOM final */
  var rec = null;
  var blocs = document.querySelectorAll('script[type="application/ld+json"]');
  for (var i = 0; i < blocs.length && !rec; i++) {
    try { rec = chercher(JSON.parse(blocs[i].textContent)); } catch (e) {}
  }

  var data;
  if (rec) {
    var y = rec.recipeYield;
    var ing = rec.recipeIngredient || rec.ingredients || [];
    var cat = [].concat(rec.recipeCategory || [], rec.keywords || []).join(',');
    data = {
      titre: txt(rec.name),
      portions: txt(Array.isArray(y) ? y[0] : y),
      temps: duree(rec.totalTime) || [duree(rec.prepTime), duree(rec.cookTime)].filter(Boolean).join(' + '),
      tags: cat.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean).slice(0, 6),
      ingredients: (Array.isArray(ing) ? ing : [ing]).map(txt).filter(Boolean),
      etapes: etapes(rec.recipeInstructions),
      notes: txt(rec.description)
    };
  } else {
    /* 2. Repli : sélection de l'utilisateur, sinon microdonnées visibles */
    var sel = txt(window.getSelection && String(window.getSelection()));
    var lis = [].map.call(document.querySelectorAll('[itemprop="recipeIngredient"],[itemprop="ingredients"],.ingredient,.wprm-recipe-ingredient'), function (e) { return txt(e.textContent); }).filter(Boolean);
    var ets = [].map.call(document.querySelectorAll('[itemprop="recipeInstructions"] li,.instruction,.wprm-recipe-instruction'), function (e) { return txt(e.textContent); }).filter(Boolean);
    data = {
      titre: txt(document.querySelector('h1') && document.querySelector('h1').textContent) || document.title,
      portions: '', temps: '', tags: [],
      ingredients: lis,
      etapes: ets.length ? ets : (sel ? sel.split(/\n+/).filter(Boolean) : []),
      notes: sel && !lis.length && !ets.length ? '' : ''
    };
    if (!lis.length && !ets.length && sel) data.ingredients = sel.split(/\n+/).filter(Boolean);
  }

  data.source = location.href;
  data.methode = rec ? 'marque-page (json-ld)' : 'marque-page (page)';

  /* Le fragment (#) n'est jamais transmis au serveur : les données restent locales. */
  var charge = btoa(unescape(encodeURIComponent(JSON.stringify(data))));
  window.open(APP + '#import=' + encodeURIComponent(charge), '_blank');
})();
