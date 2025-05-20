require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder
} = require('discord.js');
const { google } = require('googleapis');
const nameToId   = require('./mappings.json');

const {
  DISCORD_TOKEN,
  DISCORD_CHANNEL_ID,
  // Departamento
  GOOGLE_SPREADSHEET_ID,
  SHEET_RANGE,
  // Pocharia
  POCHARIA_SHEET_ID,
  POCHARIA_SHEET_RANGE,
  POCHARIA_CHANNEL_ID,
  // Tubos
  TUBOS_SHEET_ID,
  TUBOS_SHEET_RANGE,
  TUBOS_CHANNEL_ID,
  // Fisio
  FISIO_SHEET_ID,
  FISIO_SHEET_RANGE,
  FISIO_CHANNEL_ID,
  // Credenciales
  GOOGLE_SERVICE_ACCOUNT_CREDENTIALS
} = process.env;

const client = new Client({ intents: [ GatewayIntentBits.Guilds ] });

/** ––––– Helpers compartidos ––––– **/

// Normalización & extracción de IDs
function normalize(str) {
  return str.normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase();
}
const sortedNames = Object.keys(nameToId).sort((a,b)=>b.length-a.length);
function extractIdsFromCell(text) {
  let rem = normalize(text);
  const ids = [];
  for (const name of sortedNames) {
    const norm = normalize(name);
    const re   = new RegExp(`\\b${norm}\\b`, 'i');
    const m    = re.exec(rem);
    if (m) {
      ids.push(nameToId[name]);
      rem = rem.slice(0,m.index) + rem.slice(m.index+norm.length);
    }
  }
  return [...new Set(ids)];
}

// Lectura genérica de Sheets para “hoy” y “pendientes”
async function fetchTasks(sheetId, range, colAct, colEnc, colDate, colStatus) {
  const auth   = new google.auth.GoogleAuth({
    keyFile: GOOGLE_SERVICE_ACCOUNT_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const sheets = google.sheets({ version:'v4', auth });
  const res    = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  const rows   = res.data.values || [];
  const today0 = new Date(); today0.setHours(0,0,0,0);

  const today   = [];
  const pending = [];

  for (const row of rows) {
    while (row.length <= Math.max(colAct, colEnc, colDate, colStatus)) row.push('');
    const act = row[colAct].trim();
    if (!act) continue;

    const ids    = extractIdsFromCell(row[colEnc]||'');
    const parts  = (row[colDate]||'').split('/');
    if (parts.length!==3) continue;
    const [d,m,y] = parts.map(n=>parseInt(n,10));
    const date    = new Date(y,m-1,d); date.setHours(0,0,0,0);
    if ((row[colStatus]||'').trim().toLowerCase() !== 'no realizado') continue;

    const obj = { actividad: act, ids, fecha: date };
    if (date.getTime()===today0.getTime()) today.push(obj);
    else if (date < today0) pending.push(obj);
  }

  // por antigüedad
  pending.sort((a,b)=>a.fecha - b.fecha);
  return { today, pending };
}

/** ––––– Sección “Departamento” (antiguo formato) ––––– **/

// Lista de grupos en orden
const GROUPS = [
  "RM","PP","PMC","M&A","PPQA","CM","RD","TS","PI",
  "VER","VAL","OPF","OPD","OT","IPM","RKM","DAR","REQM","Departamento"
];
// Mapa de uppercase → nombre original
const groupMap = GROUPS.reduce((acc, g) => {
  acc[g.toUpperCase()] = g;
  return acc;
}, {});

async function fetchTareas() {
  const auth   = new google.auth.GoogleAuth({
    keyFile: GOOGLE_SERVICE_ACCOUNT_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res    = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SPREADSHEET_ID,
    range: SHEET_RANGE
  });
  const filas = res.data.values || [];
  const hoy   = new Date(); hoy.setHours(0,0,0,0);

  const tasksToday   = [];
  const tasksPending = [];

  for (const row of filas) {
    // Asegura que row tenga al menos 14 celdas (A→N)
    while (row.length < 14) row.push('');

    // 1. Grupo: primera palabra de columna A (idx 0)
    const codeCell = row[0].trim();
    const firstWord = codeCell.split(' ')[0] || '';
    const groupKey  = firstWord.toUpperCase();
    const group     = groupMap[groupKey] || 'Otros';

    // 2. Actividad: columna B (idx 1)
    const actividad = row[1].trim();
    if (!actividad) continue;

    // 3. Responsables: columna H (idx 7)
    const nombres = (row[7] || '')
      .split(',')
      .map(n => n.trim())
      .filter(Boolean);
    const encargadoIds = nombres
      .map(n => nameToId[n])
      .filter(Boolean);

    // 4. Fecha: columna I (idx 8) en DD/MM/YYYY
    const rawDate = row[8].trim();
    if (!rawDate) continue;
    const parts = rawDate.split('/');
    if (parts.length !== 3) continue;
    const [d, m, y] = parts.map(n => parseInt(n, 10));
    const fecha = new Date(y, m - 1, d);
    fecha.setHours(0,0,0,0);

    // 5. Estado: columna N (idx 13)
    const estado = (row[13] || '').trim().toLowerCase();

    // Clasifica
    if (fecha.getTime() === hoy.getTime()) {
      tasksToday.push({ group, actividad, nombres, encargadoIds });
    } else if (fecha.getTime() < hoy.getTime() && estado === 'no realizado') {
      tasksPending.push({ group, actividad, nombres, encargadoIds, fecha });
    }
  }

  return { tasksToday, tasksPending };
}

// 2) Construir y enviar el mensaje, con chunks ≤2000 chars
async function sendDepartment() {
  try {
    const { tasksToday, tasksPending } = await fetchTareas();
    if (!tasksToday.length && !tasksPending.length) return;

    // Ordena pendientes de más antiguas a más recientes
    tasksPending.sort((a, b) => a.fecha - b.fecha);

    const fechaLegible = new Date().toLocaleDateString('es-MX');
    const lines = [`📋 Actividades para ${fechaLegible}`];

    // -- Sección: tareas de hoy, agrupadas
    for (const group of [...GROUPS, 'Otros']) {
      const grupoHoy = tasksToday.filter(t => t.group === group);
      if (!grupoHoy.length) continue;
      lines.push(`**${group}**`);
      for (const t of grupoHoy) {
        let mentionText;
        if (t.nombres.length === 0) {
          mentionText = 'SIN ASIGNAR';
        } else if (t.encargadoIds.length === 0) {
          mentionText = 'Formato incorrecto (si son varios asignados, separarlos con comas)';
        } else {
          mentionText = t.encargadoIds.map(id => `<@${id}>`).join(', ');
        }
        lines.push(`• ${t.actividad}: ${mentionText}`);
      }
    }

    // -- Sección: pendientes
    if (tasksPending.length) {
      lines.push('⏳ Pendientes:');
      for (const group of [...GROUPS, 'Otros']) {
        const grupoPend = tasksPending.filter(t => t.group === group);
        if (!grupoPend.length) continue;
        lines.push(`**${group}**`);
        for (const t of grupoPend) {
          let mentionText;
          if (t.nombres.length === 0) {
            mentionText = 'SIN ASIGNAR';
          } else if (t.encargadoIds.length === 0) {
            mentionText = 'CHECAR PVG, FORMATO INCORRECTO';
          } else {
            mentionText = t.encargadoIds.map(id => `<@${id}>`).join(', ');
          }
          const fechaAnt = t.fecha.toLocaleDateString('es-MX');
          lines.push(`• ${t.actividad}: ${mentionText} - ${fechaAnt}`);
        }
      }
    }

    // Partir en trozos de ≤2000 chars
    const canal = await client.channels.fetch(DISCORD_CHANNEL_ID);
    const chunks = [];
    let chunk = '';
    for (const line of lines) {
      if ((chunk + '\n' + line).length > 2000) {
        chunks.push(chunk);
        chunk = line;
      } else {
        chunk = chunk ? chunk + '\n' + line : line;
      }
    }
    if (chunk) chunks.push(chunk);

    // Enviar cada chunk
    for (const msg of chunks) {
      await canal.send({ content: msg });
    }
    console.log('Tareas enviadas en', chunks.length, 'mensajes');
  } catch (err) {
    console.error('Error al enviar tareas:', err);
  }
}

/** ––––– Sección genérica para Pocharia, Tubos y Fisio ––––– **/

async function sendGeneric(title, sheetId, range, colAct, colEnc, colDate, colStatus, channelId) {
  const { today, pending } = await fetchTasks(sheetId, range, colAct, colEnc, colDate, colStatus);
  if (!today.length && !pending.length) return;

  const fechaHoy = new Date().toLocaleDateString('es-MX');
  const lines = [`📋 **${title} — ${fechaHoy}**`, ''];

  const groupBy = arr => {
    const m = new Map();
    for (const t of arr) {
      const key = t.ids.length
        ? t.ids.map(i=>`<@${i}>`).join(', ')
        : 'SIN_ASIGNAR';
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(t);
    }
    return m;
  };

  // HOY: primero SIN_ASIGNAR
  const mapHoy = groupBy(today);
  if (mapHoy.has('SIN_ASIGNAR')) {
    lines.push('**SIN ASIGNAR**');
    for (const t of mapHoy.get('SIN_ASIGNAR')) {
      lines.push(`• ${t.actividad}`);
    }
    lines.push('');
  }
  for (const [key, tasks] of mapHoy) {
    if (key==='SIN_ASIGNAR') continue;
    lines.push(key);
    for (const t of tasks) lines.push(`• ${t.actividad}`);
    lines.push('');
  }

  // PENDIENTES: igual
  if (pending.length) {
    lines.push('⌛ **Pendientes:**','');
    const mapPen = groupBy(pending);
    if (mapPen.has('SIN_ASIGNAR')) {
      lines.push('**SIN ASIGNAR**');
      for (const t of mapPen.get('SIN_ASIGNAR')) {
        const ds = t.fecha.toLocaleDateString('es-MX');
        lines.push(`• ${t.actividad} — ${ds}`);
      }
      lines.push('');
    }
    for (const [key, tasks] of mapPen) {
      if (key==='SIN_ASIGNAR') continue;
      lines.push(key);
      for (const t of tasks) {
        const ds = t.fecha.toLocaleDateString('es-MX');
        lines.push(`• ${t.actividad} — ${ds}`);
      }
      lines.push('');
    }
  }

  // envío
  const ch = await client.channels.fetch(channelId);
  let chunk = '';
  for (const l of lines) {
    if ((chunk+'\n'+l).length > 2000) {
      await ch.send(chunk);
      chunk = l;
    } else {
      chunk = chunk ? `${chunk}\n${l}` : l;
    }
  }
  if (chunk) await ch.send(chunk);
}

/** ––––– Registrar comandos slash y manejarlos ––––– **/

client.once('ready', async () => {
  console.log(`Conectado como ${client.user.tag}`);

  // Definimos un único comando /send con subcomandos
  const commands = [
    new SlashCommandBuilder()
      .setName('send')
      .setDescription('Enviar manualmente las secciones')
      .addSubcommand(sub => sub
        .setName('departamento')
        .setDescription('Envía actividades Departamento'))
      .addSubcommand(sub => sub
        .setName('pocharia')
        .setDescription('Envía actividades Pocharia'))
      .addSubcommand(sub => sub
        .setName('tubos')
        .setDescription('Envía actividades Tubos'))
      .addSubcommand(sub => sub
        .setName('fisio')
        .setDescription('Envía actividades Fisio'))
      .addSubcommand(sub => sub
        .setName('all')
        .setDescription('Envía todas las secciones'))
      .toJSON()
  ];

  // Registramos globalmente
  await client.application.commands.set(commands);
  console.log('Slash commands registrados.');
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'send') return;

  await interaction.deferReply({ ephemeral: true });
  try {
    const sub = interaction.options.getSubcommand();
    switch (sub) {
      case 'departamento':
        await sendDepartment();
        await interaction.editReply('✅ Departamento enviado.');
        break;
      case 'pocharia':
        await sendGeneric(
          'Actividades Pocharia',
          POCHARIA_SHEET_ID, POCHARIA_SHEET_RANGE,
          0,6,8,14, POCHARIA_CHANNEL_ID
        );
        await interaction.editReply('✅ Pocharia enviado.');
        break;
      case 'tubos':
        await sendGeneric(
          'Actividades Tubos',
          TUBOS_SHEET_ID, TUBOS_SHEET_RANGE,
          0,6,8,14, TUBOS_CHANNEL_ID
        );
        await interaction.editReply('✅ Tubos enviado.');
        break;
      case 'fisio':
        await sendGeneric(
          'Actividades Fisio',
          FISIO_SHEET_ID, FISIO_SHEET_RANGE,
          0,8,10,16, FISIO_CHANNEL_ID
        );
        await interaction.editReply('✅ Fisio enviado.');
        break;
      case 'all':
        await sendDepartment();
        await sendGeneric(
          'Actividades Pocharia',
          POCHARIA_SHEET_ID, POCHARIA_SHEET_RANGE,
          0,6,8,14, POCHARIA_CHANNEL_ID
        );
        await sendGeneric(
          'Actividades Tubos',
          TUBOS_SHEET_ID, TUBOS_SHEET_RANGE,
          0,6,8,14, TUBOS_CHANNEL_ID
        );
        await sendGeneric(
          'Actividades Fisio',
          FISIO_SHEET_ID, FISIO_SHEET_RANGE,
          0,8,10,16, FISIO_CHANNEL_ID
        );
        await interaction.editReply('✅ Todas las secciones enviadas.');
        break;
    }
  } catch (err) {
    console.error(err);
    await interaction.editReply('❌ Ocurrió un error al enviar.');
  }
});

client.login(DISCORD_TOKEN);












/* require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
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

const gifUrl = 'https://media.giphy.com/media/3oEjI6SIIHBdRxXI40/giphy.gif';

client.once('ready', () => {
  console.log(`Conectado como ${client.user.tag}`);

  // 2) Programa el cronjob
  cron.schedule(
    CRON_SCHEDULE,
    async () => {
      try {
        const canal = await client.channels.fetch(DISCORD_CHANNEL_ID);
        await canal.send(
          `<@1247721603987669044> ya paga la manutención `
        );
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


/* await canal.send({
  content: '¡Aquí va un GIF de celebración!',
  embeds: [{
    image: { url: gifUrl }
  }]
}); */