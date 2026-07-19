FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/
RUN npx tsc -p tsconfig.build.json \
    && ls -la dist/server/index.js \
    && echo "Build OK"

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ dist/
COPY public/ public/
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
