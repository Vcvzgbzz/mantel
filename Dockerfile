FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npx tsc && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 7411
# The config sets listen (0.0.0.0:7411 in a container) and db (on a mounted volume).
ENTRYPOINT ["node", "dist/cli.js", "-c", "/etc/mantel/mantel.yaml"]
CMD ["serve"]
