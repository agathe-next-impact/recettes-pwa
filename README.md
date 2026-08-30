# Carnet de recettes — PWA hors ligne

PWA « local-first » pour enregistrer des recettes trouvées sur le web (titre, lien source, ingrédients, étapes, tags, notes), avec authentification locale, persistance IndexedDB et fonctionnement hors ligne complet.

## Architecture

| Brique | Choix technique |
|---|---|
| Shell applicatif | `index.html` unique (HTML/CSS/JS vanilla, zéro dépendance) |
| Installation / PWA | `manifest.webmanifest` + icônes 192/512 (dont maskable) |
| Hors ligne | `sw.js` : précache du shell (cache-first), réseau d'abord pour les navigations avec repli sur le cache, stale-while-revalidate pour les polices |
| Persistance | IndexedDB (`carnet-recettes`) : store `utilisateurs` + store `recettes` indexé par propriétaire |
| Authentification | Locale : PBKDF2-SHA-256 (210 000 itérations, sel aléatoire) via WebCrypto ; session dans `localStorage` |
| Données portables | Export / import JSON intégrés |

## Lancer en local

Un service worker exige HTTPS **ou** localhost :

```bash
cd recettes-pwa
python3 -m http.server 8080
# puis ouvrir http://localhost:8080
```

Pour tester le hors ligne : ouvrir l'app une fois, puis DevTools → Network → Offline (ou couper le réseau) et recharger. Tout reste fonctionnel : consultation, création, modification, recherche.

## Déployer

N'importe quel hébergement statique HTTPS convient : Vercel, Netlify, GitHub Pages, ou un simple Nginx. Aucun build, aucun serveur applicatif. Une fois déployée, l'app est installable (bouton « Installer » du navigateur / « Ajouter à l'écran d'accueil » sur mobile).

Lors d'une mise à jour, incrémentez `VERSION` dans `sw.js` pour invalider les anciens caches.

## Limites assumées (et pistes d'évolution)

- **Authentification locale, pas serveur.** Le hachage PBKDF2 protège l'accès sur un appareil partagé, mais quelqu'un ayant accès physique à l'appareil et aux DevTools peut lire IndexedDB. Pour une vraie confidentialité multi-appareils : brancher un backend (Supabase, Firebase Auth, ou une API maison) — la couche `inscrire()/connecter()` est isolée et remplaçable telle quelle.
- **Pas de synchronisation entre appareils.** L'export/import JSON sert de pont manuel. Évolution naturelle : Background Sync + API REST, ou CRDT si édition multi-appareils.
- **Pas de scraping automatique des recettes.** Le CORS empêche un front pur de lire une page tierce ; l'app enregistre donc le lien source + la saisie. Évolution : une fonction serverless qui extrait les données `schema.org/Recipe` (JSON-LD) de l'URL collée et pré-remplit le formulaire.
