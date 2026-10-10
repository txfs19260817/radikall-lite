FROM node:24-alpine
WORKDIR /app
COPY . .
RUN node scripts/build.mjs
ENV NODE_ENV=production PORT=3000
USER node
EXPOSE 3000
CMD ["node", "adapters/node.ts"]
