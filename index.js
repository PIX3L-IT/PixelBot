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
  // Notaría
  NOTARIA_SHEET_ID,
  NOTARIA_SHEET_RANGE,
  NOTARIA_CHANNEL_ID,
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

const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
});


const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages
  ],
  partials: ['CHANNEL']
});

/** ––––– Helpers compartidos ––––– **/

/**
 * Divide un array de líneas en chunks de ≤ maxLen caracteres.
 * Retorna un array de strings.
 */
function chunkLines(lines, maxLen = 2000) {
  const chunks = [];
  let chunk = '';
  for (const line of lines) {
    // +1 para el '\n'
    if (chunk.length + line.length + 1 > maxLen) {
      chunks.push(chunk);
      chunk = line;
    } else {
      chunk = chunk ? `${chunk}\n${line}` : line;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

/**
 * Envía un array de líneas al canal (o usuario) en múltiples mensajes,
 * aplicando chunkLines(...) para no pasarse de longitud.
 */
async function sendInChunks(target, lines) {
  const chunks = chunkLines(lines);
  for (const c of chunks) {
    await target.send(c);
  }
}


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

  const sheets = google.sheets({ version:'v4', auth });
  const res    = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  const rows   = res.data.values || [];
  const today0 = new Date(); today0.setHours(0,0,0,0);

  const today   = [];
  const pending = [];
  const future  = [];

  for (const row of rows) {
    while (row.length <= Math.max(colAct, colEnc, colDate, colStatus)) row.push('');
    const act = row[colAct].trim();
    if (!act) continue;
    const ids = extractIdsFromCell(row[colEnc]||'');
    const parts = (row[colDate]||'').split('/');
    if (parts.length!==3) continue;
    const [d,m,y] = parts.map(n=>parseInt(n,10));
    const fecha   = new Date(y,m-1,d); fecha.setHours(0,0,0,0);
    if ((row[colStatus]||'').trim().toLowerCase() !== 'no realizado') continue;

    const obj = { actividad: act, ids, fecha };
    if      (fecha.getTime() === today0.getTime()) today.push(obj);
    else if (fecha.getTime() <  today0.getTime()) pending.push(obj);
    else                                           future.push(obj);
  }

  pending.sort((a,b)=>a.fecha - b.fecha);
  future.sort((a,b)=>a.fecha - b.fecha);
  return { today, pending, future };
}

/** ––––– Sección “Departamento” (antiguo formato) ––––– **/

// Lista de grupos en orden
const GROUPS = [
  "RM","PP","PMC","MA","PPQA","CM","RD","TS","PI",
  "VER","VAL","OPF","OPD","OT","IPM","RKM","DAR","REQM","Departamento"
];
// Mapa de uppercase → nombre original
const groupMap = GROUPS.reduce((acc, g) => {
  acc[g.toUpperCase()] = g;
  return acc;
}, {});

async function fetchTareas() {

  const sheets = google.sheets({ version: 'v4', auth });
  const res    = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SPREADSHEET_ID,
    range: SHEET_RANGE
  });
  const filas = res.data.values || [];
  const hoy   = new Date(); hoy.setHours(0,0,0,0);

  const tasksToday   = [];
  const tasksPending = [];
  const tasksFuture  = [];

  for (const row of filas) {
    while (row.length < 14) row.push('');
    const codeCell = row[0].trim().split(' ')[0].toUpperCase();
    const group    = groupMap[codeCell] || 'Otros';
    const actividad = row[1].trim();
    if (!actividad) continue;

    const nombres      = (row[7]||'').split(',').map(n=>n.trim()).filter(Boolean);
    const encargadoIds = nombres.map(n=>nameToId[n]).filter(Boolean);
    const rawDate      = row[8].trim();
    if (!rawDate) continue;
    const [d,m,y] = rawDate.split('/').map(n=>parseInt(n,10));
    const fecha   = new Date(y,m-1,d); fecha.setHours(0,0,0,0);

    const estado = (row[13]||'').trim().toLowerCase();
    if (estado !== 'no realizado') continue;

    const obj = { group, actividad, nombres, encargadoIds, fecha };
    if      (fecha.getTime() === hoy.getTime()) tasksToday.push(obj);
    else if (fecha.getTime() <  hoy.getTime()) tasksPending.push(obj);
    else                                        tasksFuture.push(obj);
  }

  tasksPending.sort((a,b) => a.fecha - b.fecha);
  tasksFuture.sort((a,b)  => a.fecha - b.fecha);
  return { tasksToday, tasksPending, tasksFuture };
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
            mentionText = 'Formato incorrecto (si son varios asignados, separarlos con comas)';
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

/** ––––– Sección genérica para Notaría, Tubos y Fisio ––––– **/

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

// Nada más un área del CMMI
async function sendArea(area) {
  try {
    const { tasksToday, tasksPending } = await fetchTareas();
    // Filtrar sólo el área solicitada
    const hoyStr = new Date().toLocaleDateString('es-MX');
    const lines = [`📋 Actividades **${area}** para ${hoyStr}`, ''];

    // Tareas de hoy
    const hoy = tasksToday.filter(t => t.group === area);
    if (hoy.length) {
      for (const t of hoy) {
        const mention = t.encargadoIds.length
          ? t.encargadoIds.map(id => `<@${id}>`).join(', ')
          : (t.nombres.length ? 'Formato incorrecto' : 'SIN ASIGNAR');
        lines.push(`• ${t.actividad}: ${mention}`);
      }
    } else {
      lines.push('— No hay actividades para hoy —');
    }

    // Pendientes
    const pen = tasksPending.filter(t => t.group === area);
    if (pen.length) {
      lines.push('', '⏳ Pendientes:');
      for (const t of pen) {
        const mention = t.encargadoIds.length
          ? t.encargadoIds.map(id => `<@${id}>`).join(', ')
          : (t.nombres.length ? 'Formato incorrecto' : 'SIN ASIGNAR');
        const fecha = t.fecha.toLocaleDateString('es-MX');
        lines.push(`• ${t.actividad}: ${mention} — ${fecha}`);
      }
    }

    // Partir en trozos ≤2000 caracteres
    const canal = await client.channels.fetch(DISCORD_CHANNEL_ID);
    let chunk = '';
    for (const line of lines) {
      if ((chunk + '\n' + line).length > 2000) {
        await canal.send(chunk);
        chunk = line;
      } else {
        chunk = chunk ? `${chunk}\n${line}` : line;
      }
    }
    if (chunk) await canal.send(chunk);

  } catch (err) {
    console.error(`Error al enviar área ${area}:`, err);
  }
}

/** ––––– Registrar comandos slash y manejarlos ––––– **/
client.once('ready', async () => {
  console.log(`Conectado como ${client.user.tag}`);

  // 1) Builder de /send con todos sus subcomandos
  const sendBuilder = new SlashCommandBuilder()
    .setName('send')
    .setDescription('Enviar manualmente las secciones')
    .addSubcommand(sub => sub.setName('departamento').setDescription('Envía actividades Departamento'))
    .addSubcommand(sub => sub.setName('notaria')    .setDescription('Envía actividades Notaría'))
    .addSubcommand(sub => sub.setName('tubos')       .setDescription('Envía actividades Tubos'))
    .addSubcommand(sub => sub.setName('fisio')       .setDescription('Envía actividades Fisio'))
    .addSubcommand(sub => sub.setName('all')         .setDescription('Envía todas las secciones'));
  for (const g of GROUPS) {
    if (g === 'Departamento') continue;
    sendBuilder.addSubcommand(sub =>
      sub.setName(g.toLowerCase())
         .setDescription(`Envía actividades ${g}`)
    );
  }

  // 2) Builder de /misactividades
  const pendingBuilder = new SlashCommandBuilder()
    .setName('misactividades')
    .setDescription('Recibe tus actividades por DM');

  // 3) Registramos AMBOS comandos de forma GLOBAL
  const globalCommands = [
    sendBuilder.toJSON(),
    pendingBuilder.toJSON()
  ];
  await client.application.commands.set(globalCommands);

  console.log('✔️  Comandos globales (/send + /misactividades) registrados.');
});


/**
 * Envía al usuario (por DM) las mismas líneas que sendDepartment()
 */
async function sendDepartmentToUser(user) {
  const { tasksToday, tasksPending } = await fetchTareas();

  const hoy = new Date().toLocaleDateString('es-MX');
  const lines = [`📋 Actividades para ${hoy}`, ''];

  // HOY
  for (const group of [...GROUPS, 'Otros']) {
    const hoyGrupo = tasksToday.filter(t => t.group === group);
    if (!hoyGrupo.length) continue;
    lines.push(`**${group}**`);
    for (const t of hoyGrupo) {
      const mention = t.encargadoIds.length
        ? t.encargadoIds.map(id => `<@${id}>`).join(', ')
        : (t.nombres.length ? 'Formato incorrecto' : 'SIN ASIGNAR');
      lines.push(`• ${t.actividad}: ${mention}`);
    }
  }

  // PENDIENTES
  if (tasksPending.length) {
    lines.push('', '⏳ Pendientes:');
    for (const group of [...GROUPS, 'Otros']) {
      const pen = tasksPending.filter(t => t.group === group);
      if (!pen.length) continue;
      lines.push(`**${group}**`);
      for (const t of pen) {
        const mention = t.encargadoIds.length
          ? t.encargadoIds.map(id => `<@${id}>`).join(', ')
          : (t.nombres.length ? 'Formato incorrecto' : 'SIN ASIGNAR');
        const fecha = t.fecha.toLocaleDateString('es-MX');
        lines.push(`• ${t.actividad}: ${mention} — ${fecha}`);
      }
    }
  }

  await sendInChunks(user, lines);
}

/**
 * Envía al usuario (por DM) las mismas líneas que sendGeneric(...)
 */
async function sendGenericToUser(user, title, sheetId, range, colAct, colEnc, colDate, colStatus) {
  const { today, pending } = await fetchTasks(sheetId, range, colAct, colEnc, colDate, colStatus);

  const fechaHoy = new Date().toLocaleDateString('es-MX');
  const lines = [`📋 **${title} — ${fechaHoy}**`, ''];

  // HOY
  const mapHoy = new Map();
  today.forEach(t => {
    const key = t.ids.length ? t.ids.map(i=>`<@${i}>`).join(', ') : 'SIN_ASIGNAR';
    (mapHoy.get(key) || mapHoy.set(key, []).get(key)).push(t);
  });
  for (const [key, tasks] of mapHoy) {
    lines.push(key);
    tasks.forEach(t => lines.push(`• ${t.actividad}`));
    lines.push('');
  }

  // PENDIENTES
  if (pending.length) {
    lines.push('⌛ **Pendientes:**', '');
    const mapPen = new Map();
    pending.forEach(t => {
      const key = t.ids.length ? t.ids.map(i=>`<@${i}>`).join(', ') : 'SIN_ASIGNAR';
      (mapPen.get(key) || mapPen.set(key, []).get(key)).push(t);
    });
    for (const [key, tasks] of mapPen) {
      lines.push(key);
      tasks.forEach(t => {
        const fecha = t.fecha.toLocaleDateString('es-MX');
        lines.push(`• ${t.actividad} — ${fecha}`);
      });
      lines.push('');
    }
  }

  await sendInChunks(user, lines);
}

/**
 * Envía al usuario (por DM) las mismas líneas que sendArea(area)
 */
async function sendAreaToUser(user, area) {
  const { tasksToday, tasksPending } = await fetchTareas();

  const hoyStr = new Date().toLocaleDateString('es-MX');
  const lines = [`📋 Actividades **${area}** para ${hoyStr}`, ''];

  // HOY
  const hoy = tasksToday.filter(t => t.group === area);
  if (hoy.length) {
    hoy.forEach(t => {
      const mention = t.encargadoIds.length
        ? t.encargadoIds.map(id => `<@${id}>`).join(', ')
        : (t.nombres.length ? 'Formato incorrecto' : 'SIN ASIGNAR');
      lines.push(`• ${t.actividad}: ${mention}`);
    });
    lines.push('');
  } else {
    lines.push('— No hay actividades para hoy —', '');
  }

  // PENDIENTES
  const pen = tasksPending.filter(t => t.group === area);
  if (pen.length) {
    lines.push('⏳ Pendientes:');
    pen.forEach(t => {
      const mention = t.encargadoIds.length
        ? t.encargadoIds.map(id => `<@${id}>`).join(', ')
        : (t.nombres.length ? 'Formato incorrecto' : 'SIN ASIGNAR');
      const fecha = t.fecha.toLocaleDateString('es-MX');
      lines.push(`• ${t.actividad}: ${mention} — ${fecha}`);
    });
  }

  await sendInChunks(user, lines);
}


/** ––––– Manejar interacciones ––––– **/
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const isDM = !interaction.guildId;      // true si es un mensaje directo
  const cmd  = interaction.commandName;
  const sub  = isDM && cmd === 'send'
    ? interaction.options.getSubcommand()
    : interaction.options.getSubcommand?.(); 

  try {
    // ————— /send —————
    if (cmd === 'send') {
      if (isDM) {
        // RESPONDE POR DM
        switch (sub) {
          case 'departamento':
            await sendDepartmentToUser(interaction.user);
            break;
          case 'notaria':
            await sendGenericToUser(
              interaction.user,
              'Actividades Notaría',
              NOTARIA_SHEET_ID, NOTARIA_SHEET_RANGE,
              0,6,8,14
            );
            break;
          case 'tubos':
            await sendGenericToUser(
              interaction.user,
              'Actividades Tubos',
              TUBOS_SHEET_ID, TUBOS_SHEET_RANGE,
              0,6,8,14
            );
            break;
          case 'fisio':
            await sendGenericToUser(
              interaction.user,
              'Actividades Fisio',
              FISIO_SHEET_ID, FISIO_SHEET_RANGE,
              0,8,10,16
            );
            break;
          case 'all':
            await sendDepartmentToUser(interaction.user);
            await sendGenericToUser(interaction.user, 'Notaría', NOTARIA_SHEET_ID, NOTARIA_SHEET_RANGE, 0,6,8,14);
            await sendGenericToUser(interaction.user, 'Tubos',   TUBOS_SHEET_ID,   TUBOS_SHEET_RANGE,   0,6,8,14);
            await sendGenericToUser(interaction.user, 'Fisio',   FISIO_SHEET_ID,   FISIO_SHEET_RANGE,   0,8,10,16);
            break;
          default:
            if (GROUPS.map(g => g.toLowerCase()).includes(sub)) {
              const area = groupMap[sub.toUpperCase()];
              await sendAreaToUser(interaction.user, area);
            } else {
              await interaction.user.send('❌ Subcomando no reconocido.');
            }
        }
        return;
      }

      // — RESPUESTA EN CANAL —  
      await interaction.deferReply({ ephemeral: true });
      switch (sub) {
        case 'departamento':
          await sendDepartment();
          await interaction.editReply('✅ Departamento enviado.');
          break;
        case 'notaria':
          await sendGeneric('Actividades Notaría', NOTARIA_SHEET_ID, NOTARIA_SHEET_RANGE, 0,6,8,14, NOTARIA_CHANNEL_ID);
          await interaction.editReply('✅ Notaría enviado.');
          break;
        case 'tubos':
          await sendGeneric('Actividades Tubos', TUBOS_SHEET_ID, TUBOS_SHEET_RANGE, 0,6,8,14, TUBOS_CHANNEL_ID);
          await interaction.editReply('✅ Tubos enviado.');
          break;
        case 'fisio':
          await sendGeneric('Actividades Fisio', FISIO_SHEET_ID, FISIO_SHEET_RANGE, 0,8,10,16, FISIO_CHANNEL_ID);
          await interaction.editReply('✅ Fisio enviado.');
          break;
        case 'all':
          await sendDepartment();
          await sendGeneric('Actividades Notaría', NOTARIA_SHEET_ID, NOTARIA_SHEET_RANGE, 0,6,8,14, NOTARIA_CHANNEL_ID);
          await sendGeneric('Actividades Tubos',   TUBOS_SHEET_ID,   TUBOS_SHEET_RANGE,   0,6,8,14, TUBOS_CHANNEL_ID);
          await sendGeneric('Actividades Fisio',   FISIO_SHEET_ID,   FISIO_SHEET_RANGE,   0,8,10,16, FISIO_CHANNEL_ID);
          await interaction.editReply('✅ Todas las secciones enviadas.');
          break;
        default:
          if (GROUPS.map(g => g.toLowerCase()).includes(sub)) {
            const area = groupMap[sub.toUpperCase()];
            await sendArea(area);
            await interaction.editReply(`✅ ${area} enviado.`);
          } else {
            await interaction.editReply('❌ Subcomando no reconocido.');
          }
      }
      return;
    }

    // ————— /misactividades —————
    if (cmd === 'misactividades') {
      // siempre DM
      await sendMyPending(interaction);
      return;
    }
  } catch (err) {
    console.error(err);
    if (isDM) {
      await interaction.user.send('❌ Ocurrió un error al procesar tu solicitud.');
    } else {
      await interaction.editReply('❌ Ocurrió un error al procesar tu solicitud.');
    }
  }
});



/** ––––– Función que toma un Interaction y DM al usuario sus tareas pendientes ––––– **/
/**
 * Envía por DM las actividades de hoy y las pendientes de la persona que invoca el comando.
 */
/**
 * Envía por DM las actividades de HOY y las PENDIENTES de la persona que invoca el comando.
 */
async function sendMyPending(interaction) {
  const userId = interaction.user.id;
  const lines  = [];

  // — HOY —
  lines.push('📋 **Tus actividades para HOY**','');
  let hasToday = false;

  const { tasksToday: deptToday, tasksPending: deptPending, tasksFuture: deptFuture } = await fetchTareas();
  const myDeptToday = deptToday.filter(t => t.encargadoIds.includes(userId));
  if (myDeptToday.length) {
    hasToday = true;
    lines.push('**Departamento**');
    myDeptToday.forEach(t => lines.push(`• ${t.actividad}`));
    lines.push('');
  }

  const genericConfigs = [
    ['Notaría', NOTARIA_SHEET_ID, NOTARIA_SHEET_RANGE, 0,6,8,14],
    ['Tubos',    TUBOS_SHEET_ID,   TUBOS_SHEET_RANGE,   0,6,8,14],
    ['Fisio',    FISIO_SHEET_ID,   FISIO_SHEET_RANGE,   0,8,10,16],
  ];
  for (const [title, sid, range, ca, ce, cd, cs] of genericConfigs) {
    const { today: genToday } = await fetchTasks(sid, range, ca, ce, cd, cs);
    const mineToday = genToday.filter(t => t.ids.includes(userId));
    if (mineToday.length) {
      hasToday = true;
      lines.push(`**${title}**`);
      mineToday.forEach(t => lines.push(`• ${t.actividad}`));
      lines.push('');
    }
  }

  if (!hasToday) lines.push('✅ No tienes actividades para hoy.','');

  // — PENDIENTES —
  lines.push('⌛ **Tus actividades PENDIENTES**','');
  let hasPending = false;

  const myDeptPend = deptPending.filter(t => t.encargadoIds.includes(userId));
  if (myDeptPend.length) {
    hasPending = true;
    lines.push('**Departamento**');
    myDeptPend.forEach(t => {
      const fecha = t.fecha.toLocaleDateString('es-MX');
      lines.push(`• [${fecha}] ${t.actividad}`);
    });
    lines.push('');
  }

  for (const [title, sid, range, ca, ce, cd, cs] of genericConfigs) {
    const { pending: genPend } = await fetchTasks(sid, range, ca, ce, cd, cs);
    const minePend = genPend.filter(t => t.ids.includes(userId));
    if (minePend.length) {
      hasPending = true;
      lines.push(`**${title}**`);
      minePend.forEach(t => {
        const fecha = t.fecha.toLocaleDateString('es-MX');
        lines.push(`• [${fecha}] ${t.actividad}`);
      });
      lines.push('');
    }
  }

  if (!hasPending) lines.push('✅ ¡No tienes actividades pendientes!','');

  // — FUTURAS —
  lines.push('🤖 **Tus actividades FUTURAS**','');
  let hasFuture = false;

  const myDeptFuture = deptFuture.filter(t => t.encargadoIds.includes(userId));
  if (myDeptFuture.length) {
    hasFuture = true;
    lines.push('**Departamento**');
    myDeptFuture.forEach(t => {
      const fecha = t.fecha.toLocaleDateString('es-MX');
      lines.push(`• [${fecha}] ${t.actividad}`);
    });
    lines.push('');
  }

  for (const [title, sid, range, ca, ce, cd, cs] of genericConfigs) {
    const { future: genFuture } = await fetchTasks(sid, range, ca, ce, cd, cs);
    const mineFuture = genFuture.filter(t => t.ids.includes(userId));
    if (mineFuture.length) {
      hasFuture = true;
      lines.push(`**${title}**`);
      mineFuture.forEach(t => {
        const fecha = t.fecha.toLocaleDateString('es-MX');
        lines.push(`• [${fecha}] ${t.actividad}`);
      });
      lines.push('');
    }
  }

  if (!hasFuture) lines.push('✅ No tienes actividades en el futuro.');

  // — Enviar DM —
  await interaction.sendInChunks(user, lines);
}


client.login(DISCORD_TOKEN);
