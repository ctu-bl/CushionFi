# Adminer

1. Start the Docker stack:

```bash
yarn keeper:docker:up
```

2. Open Adminer in your browser:

- `http://127.0.0.1:8080`  
  (or the port from `KEEPER_ADMINER_PORT` in `keeper/.env`)

3. Log in with:

- System: `PostgreSQL`
- Server: `postgres`
- Username: `KEEPER_DB_USER`
- Password: `KEEPER_DB_PASSWORD`
- Database: `KEEPER_DB_NAME`
