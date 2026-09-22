# ARVEXA Admin — Console PWA

Console d'administration ARVEXA School, PWA standalone.

## Installation

1. Créer un nouveau dépôt GitHub
2. Copier tous les fichiers
3. Vercel : New Project → Import repo
4. Framework Preset : Other
5. Build Command : (vide)
6. Output Directory : `.`
7. Deploy

## Accès

URL : https://ton-admin.vercel.app

**Mot de passe par défaut** : `arvexa2026`

⚠️ **À CHANGER IMMÉDIATEMENT** — voir ci-dessous.

## Changer le mot de passe

1. Va sur https://emn178.github.io/online-tools/sha1.html
2. Tape ton nouveau mot de passe
3. Copie le hash SHA-1 obtenu
4. Dans `index.html`, remplace :
   ```js
   const ADMIN_PASSWORD_HASH = 'NOUVEAU_HASH';
