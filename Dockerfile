FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev --omit=optional
COPY bin ./bin
COPY src ./src
COPY projects ./projects
COPY examples ./examples
VOLUME ["/app/data", "/app/output", "/app/projects"]
ENTRYPOINT ["node", "bin/serp-tracker.js"]
# weekly reports every Monday 07:00 (container time zone): docker run -d --env-file .env -v ... image schedule <project> --day mon --at 07:00
CMD ["doctor"]
