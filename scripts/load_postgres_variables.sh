POSTGRES_CONTAINER_ID=$(podman ps --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --filter "label=com.docker.compose.service=postgres" --format '{{.ID}}')

if [ -n "$POSTGRES_CONTAINER_ID" ]; then
  POSTGRES_USER=$(podman inspect "$POSTGRES_CONTAINER_ID" | jq -r '.[0].Config.Env[] | select(startswith("POSTGRES_USER=")) | split("=")[1]')
  POSTGRES_PASSWORD=$(podman inspect "$POSTGRES_CONTAINER_ID" | jq -r '.[0].Config.Env[] | select(startswith("POSTGRES_PASSWORD=")) | split("=")[1]')
  POSTGRES_DB=$(podman inspect "$POSTGRES_CONTAINER_ID" | jq -r '.[0].Config.Env[] | select(startswith("POSTGRES_DB=")) | split("=")[1]')
  POSTGRES_PORT=$(podman inspect "$POSTGRES_CONTAINER_ID" | jq -r '.[0].NetworkSettings.Ports["5432/tcp"][0].HostPort')
  POSTGRES_HOST=127.0.0.1

  export MY_APP_POSTGRES_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"
else
  unset MY_APP_POSTGRES_URL
fi
