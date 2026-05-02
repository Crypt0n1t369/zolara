FROM node:22-alpine AS build

WORKDIR /app

# Install all dependencies for TypeScript build.
COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Runtime image installs production dependencies only.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=build /app/dist ./dist
COPY scripts/container-lifecycle-loop.sh ./scripts/container-lifecycle-loop.sh

EXPOSE 3000

CMD ["npm", "start"]
