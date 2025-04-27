require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { google } = require('googleapis');
const cron = require('node-cron');

const {
  DISCORD_TOKEN,
  DISCORD_CHANNEL_ID,
  GOOGLE_SPREADSHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_CREDENTIALS,
  SHEET_RANGE,
  TIMEZONE,
  CRON_SCHEDULE
} = process.env;

// 1) Inicializa cliente de Discord
const client = new Client({
  intents: [ GatewayIntentBits.Guilds ]
});

async function fetchTareasHoy() {
  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_SERVICE_ACCOUNT_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SPREADSHEET_ID,
    range: SHEET_RANGE    // debe ser: Actividades!B2:I
  });
  
  const filas = res.data.values || [];
  if (filas.length === 0) return [];

  // Fecha de hoy sin hora
  const hoy = new Date();
  hoy.setHours(0,0,0,0);

  const tareas = [];

  for (const row of filas) {
    // Asegura que la fila tenga al menos 8 celdas
    // (rellena con cadena vacía si es más corta)
    while (row.length < 8) row.push('');

    const celda = row[7].trim();  // columna I
    if (!celda) continue;         // si está vacía, saltar

    const partes = celda.split('/');
    if (partes.length !== 3) continue;  // no es DD/MM/YYYY válido

    const [d, m, a] = partes.map(n => parseInt(n, 10));
    const fecha = new Date(a, m - 1, d);
    fecha.setHours(0,0,0,0);

    if (fecha.getTime() === hoy.getTime()) {
      tareas.push(`• ${row[0]}`);     // columna B
    }
  }

  return tareas;
}


// 3) Función que arma el mensaje y lo envía al canal
async function sendTareas() {
  try {
    const tareas = await fetchTareasHoy();
    if (tareas.length === 0) return; // no hay tareas hoy

    const fechaLegible = new Date().toLocaleDateString('es-MX');
    const mensaje = `📋 **Actividades para ${fechaLegible}**\n${tareas.join('\n')}`;
    const canal = await client.channels.fetch(DISCORD_CHANNEL_ID);
    await canal.send({ content: mensaje });
    console.log('Tareas enviadas');
  } catch (err) {
    console.error('Error al enviar tareas:', err);
  }
}

// 4) Cuando el bot conecte, programa el cron
client.once('ready', () => {
  console.log(`Conectado como ${client.user.tag}`);
  cron.schedule(CRON_SCHEDULE, sendTareas, { timezone: TIMEZONE });
});

// 5) Inicia sesión en Discord
client.login(DISCORD_TOKEN);







/* 
require('dotenv').config();
const { Client, GatewayIntentBits  } = require('discord.js');
const cron = require('node-cron');

// Variables desde .env
const {
  DISCORD_TOKEN,      // Token de tu bot
  DISCORD_CHANNEL_ID, // ID del canal donde enviar el mensaje
  CRON_SCHEDULE,      // Ej: '0 8 * * *'
  TIMEZONE            // Ej: 'America/Mexico_City'
} = process.env;

// 1) Inicializa cliente de Discord
const client = new Client({
    intents: [ GatewayIntentBits.Guilds ]
  });
client.once('ready', () => {
  console.log(`Conectado como ${client.user.tag}`);

  // 2) Programa el cronjob
  cron.schedule(
    CRON_SCHEDULE,
    async () => {
      try {
        const canal = await client.channels.fetch(DISCORD_CHANNEL_ID);
        await canal.send('⣿⣿⣿⠟⠛⠛⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡟⢋⣩⣉⢻ ⣿⣿⣿⠀⣿⣶⣕⣈⠹⠿⠿⠿⠿⠟⠛⣛⢋⣰⠣⣿⣿⠀⣿ ⣿⣿⣿⡀⣿⣿⣿⣧⢻⣿⣶⣷⣿⣿⣿⣿⣿⣿⠿⠶⡝⠀⣿ ⣿⣿⣿⣷⠘⣿⣿⣿⢏⣿⣿⣋⣀⣈⣻⣿⣿⣷⣤⣤⣿⡐⢿ ⣿⣿⣿⣿⣆⢩⣝⣫⣾⣿⣿⣿⣿⡟⠿⠿⠦⠀⠸⠿⣻⣿⡄⢻ ⣿⣿⣿⣿⣿⡄⢻⣿⣿⣿⣿⣿⣿⣿⣿⣶⣶⣾⣿⣿⣿⣿⠇⣼ ⣿⣿⣿⣿⣿⣿⡄⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡟⣰ ⣿⣿⣿⣿⣿⣿⠇⣼⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⢀⣿ ⣿⣿⣿⣿⣿⠏⢰⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⢸⣿ ⣿⣿⣿⣿⠟⣰⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠀⣿ ⣿⣿⣿⠋⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡄⣿ ⣿⣿⠋⣼⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇⢸ ⣿⠏⣼⣿⣿⣿⣿⣿⣿⣿⣿');
        console.log('Mensaje de prueba enviado.');
      } catch (err) {
        console.error('Error al enviar el mensaje de prueba:', err);
      }
    },
    { timezone: TIMEZONE }
  );
});

// 3) Inicia sesión
client.login(DISCORD_TOKEN);
 */