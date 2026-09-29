FROM node:22-slim
WORKDIR /app
COPY services/api/src ./services/api/src
ENV PORT=4000 DB_PATH=/data/app.db NOTIFICATION_OUTBOX_PATH=/data/outbox.log
VOLUME /data
EXPOSE 4000
USER node
CMD ["node","--experimental-strip-types","--no-warnings","services/api/src/server.ts"]
