# Geometry Dash Web

Clone web di Geometry Dash in un unico file HTML, con un server Node che fornisce account,
livelli online, classifiche, progressi e lobby multiplayer.

| File | Ruolo |
| --- | --- |
| `index.html` | Il gioco completo (HTML + CSS + JS, asset inline). Usa le API su `/api` dello stesso dominio |
| `server.js` | Server Node senza dipendenze: serve `index.html`, le API `/api/*`, le lobby e il ping `/ping` |
| `package.json` | Script `start` (`node server.js`) |
| `render.yaml` | Blueprint Render: web service Node, piano free, health check su `/ping` |

## Dove è pubblicato

- **Gioco (pagina)**: <https://gattoita-lab.github.io/Geometry-dash-Web/> - GitHub Pages, branch `main`, root del repo.
- **Server / API**: <https://geometry-dash-web-italia.onrender.com> - servizio Render creato dal Blueprint.

`index.html` contiene la riga `window.GD_SERVER = "https://geometry-dash-web-italia.onrender.com"`:
la pagina gira su GitHub Pages e le funzioni online (account, livelli online, lobby) chiamano le API su
Render, che risponde con CORS aperto. Se togli quella riga il gioco gira solo in locale, senza account,
livelli online e lobby.

## In locale

```bash
npm start
# apri http://localhost:8080
```

Variabili utili:

| Variabile | Default | Significato |
| --- | --- | --- |
| `PORT` | `8080` | Porta HTTP (Render la imposta da solo) |
| `DATA_FILE` | `gd-data.json` | File in cui il server salva account, livelli e progressi (usato quando non c'è database) |
| `MONGODB_URI` | — | Stringa di connessione MongoDB Atlas: se impostata, account, livelli e progressi vivono nel database e sopravvivono a deploy e riavvii |
| `MONGODB_DB` | `geometrydash` | Nome del database MongoDB da usare |
| `ADMINS` | `gattoitaliano` | Nomi utente con permessi admin, separati da virgola |

## Deploy su Render - Opzione A: Blueprint (consigliata)

1. Apri <https://dashboard.render.com/blueprints> e scegli **New Blueprint Instance**.
2. Collega GitHub e seleziona il repository `gattoitA-lab/Geometry-dash-Web`.
3. Render legge `render.yaml` e propone il servizio `geometry-dash-web-italia` (piano Free).
   Premi **Apply** e attendi il primo build.
4. Apri l'URL `https://geometry-dash-web-italia.onrender.com`: la pagina del gioco viene servita
   dal server insieme alle API, quindi account, livelli online e lobby funzionano subito.

## Deploy su Render - Opzione B: Web Service manuale

1. Dashboard Render → **New +** → **Web Service** → collega il repository.
2. Compila:
   - **Language / Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/ping`
   - **Instance Type**: Free
3. **Create Web Service** e attendi la fine del deploy.

Il nome del servizio determina l'URL (`https://<nome>.onrender.com`): se il nome scelto è già
occupato nel tuo account, Render rifiuta la creazione, quindi usa un nome libero e aggiorna
di conseguenza `render.yaml`.

## Note pratiche

- **Il piano free va in sleep** dopo circa 15 minuti senza traffico: la prima richiesta dopo la
  pausa richiede 30-60 secondi (cold start).
- **Persistenza**: con `MONGODB_URI` impostata account, livelli e progressi restano nel database
  e sopravvivono a deploy, riavvii e sleep. Senza quella variabile il server usa `gd-data.json`,
  che sul piano free di Render è effimero (si perde a ogni deploy).

  Per attivarla: crea un cluster gratuito su MongoDB Atlas, aggiungi un utente del database,
  consenti l'accesso da `0.0.0.0/0` (Render free usa IP in uscita variabili) e copia la stringa
  `mongodb+srv://...`. Poi, nella dashboard di Render → servizio `geometry-dash-web-italia` →
  **Environment**, aggiungi `MONGODB_URI` con quel valore e rilancia il deploy. Al primo avvio il
  server carica nel database i dati eventualmente già presenti in `gd-data.json`.
- `index.html` pesa circa 5 MB: il server lo comprime in brotli/gzip, quindi il download reale è
  intorno a 0,8 MB. Se metti un CDN davanti, lascia passare `Accept-Encoding`.
- Se in futuro separi gioco e API su due domini diversi, il client accetta `window.GD_SERVER`
  o la chiave `gd-server` in localStorage con l'URL del server; con gioco e API sullo stesso
  dominio non serve impostare nulla.
