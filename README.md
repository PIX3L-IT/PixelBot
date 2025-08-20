# PixelBot

PixelBot is a Discord bot that integrates with Google Sheets to post daily or pending activities in channels or direct messages. User–Discord mappings are configured in mappings.json.

## Requirements
- Node.js 18+
- A Discord bot and its token
- Google service credentials with read-only access to the sheets

## Installation
1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a .env file with the following variables:
   ```bash
   DISCORD_TOKEN=...
   DISCORD_CHANNEL_ID=...
   # Departamento
   GOOGLE_SPREADSHEET_ID=...
   SHEET_RANGE=...
   # Notaría
   NOTARIA_SHEET_ID=...
   NOTARIA_SHEET_RANGE=...
   NOTARIA_CHANNEL_ID=...
   # Tubos
   TUBOS_SHEET_ID=...
   TUBOS_SHEET_RANGE=...
   TUBOS_CHANNEL_ID=...
   # Fisio
   FISIO_SHEET_ID=...
   FISIO_SHEET_RANGE=...
   FISIO_CHANNEL_ID=...
   # Credenciales
   GOOGLE_SERVICE_ACCOUNT_CREDENTIALS='{...}'
   ```
3. Run the bot:
   ```bash
   node index.js
   ```

## Commands
- `/send` – Sends activities to the corresponding channels. Includes subcommands such as `departamento`, `notaria`, `tubos`, `fisio` and others defined in the code.
- `/misactividades` – Sends the user’s activities by DM.
