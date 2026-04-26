# Dockerfile for Midstream — explicit build instructions for Railway/Fly/Render.
#
# Why a Dockerfile and not Railway's auto-builder:
#   The project runs TypeScript directly via `tsx` (a devDependency) instead of
#   compiling to JS first. Railway's Railpack auto-builder fails to construct a
#   build plan for this shape — it expects either a precompiled `dist/` output
#   or a `start` script that points to a `.js` file. A Dockerfile sidesteps the
#   guesswork.
#
# One image, two services:
#   The seller (server/seller.ts) and web-server (web-server/index.ts) ship as
#   ONE image. Railway runs different entry points by overriding the start
#   command per service:
#     - midstream-seller  → Start Command: npm run seller
#     - midstream-web     → Start Command: npm run web
#   The CMD below is just a default; per-service Start Commands override it.

FROM node:20-slim

WORKDIR /app

# Copy lockfiles first so dependency layer caches across code changes
COPY package*.json ./

# Install ALL deps including devDependencies. `tsx` is a devDep but is
# needed at runtime to execute the .ts entry points — so we cannot strip
# devDeps. Railway sometimes sets NODE_ENV=production which would skip
# devDeps by default; --include=dev forces them in regardless.
RUN npm ci --include=dev

# Copy the rest of the source
COPY . .

# Documentation only — Railway/Fly inject PORT and the app binds to it.
EXPOSE 3000

# Default entry point. Per-service Start Command in Railway overrides this.
CMD ["npm", "run", "seller"]
