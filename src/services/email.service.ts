import { Resend } from "resend";

// ────────────────────────────────────────────────────────────────────────
// Singleton lazy de Resend. Si la API key falta, NO instanciamos (deja
// un mensaje claro en logs y devuelve false en `emailEnabled()`).
// Los handlers usan Promise.allSettled así que esto no rompe la request:
// simplemente el email no se manda y queda logueado.
// ────────────────────────────────────────────────────────────────────────

let resendClient: Resend | null = null;

function getClient(): Resend | null {
  if (resendClient) return resendClient;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || apiKey.startsWith("re_replace_me")) {
    return null;
  }
  resendClient = new Resend(apiKey);
  return resendClient;
}

function fromAddress(): string | null {
  const v = process.env.FROM_EMAIL;
  return v && v.length > 0 ? v : null;
}

function publicUrl(): string {
  return (process.env.PUBLIC_URL ?? "http://localhost:4200").replace(/\/+$/, "");
}

function whatsappNumber(): string | null {
  const v = process.env.WHATSAPP_NUMBER;
  return v && v.length > 0 ? v : null;
}

function adminEmail(): string | null {
  const v = process.env.ADMIN_EMAIL;
  return v && v.length > 0 ? v : null;
}

// ────────────────────────────────────────────────────────────────────────
// Helpers de fecha en español (Europe/Madrid)
// El frontend ya hace esto. Acá lo duplicamos para no acoplar el template
// a un helper compartido. Si en el futuro hay desfase, lo unificamos.
// ────────────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

const WEEKDAY_NAMES = [
  "domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado",
];

/**
 * Devuelve la descripción humana del día: "miércoles 15 de julio".
 * Usa Intl.DateTimeFormat con zona Europe/Madrid para que la fecha que se
 * muestra en el email SIEMPRE coincida con el día que el cliente ve en
 * pantalla, independientemente de dónde esté el servidor.
 */
function humanDate(yyyyMmDd: string): string {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  // Construimos un Date UTC mediodía para evitar drift por DST.
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const fmt = new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const parts = fmt.formatToParts(dt);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const day = parts.find((p) => p.type === "day")?.value ?? "";
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  // `Intl` ya devuelve "miércoles", "15", "julio" en minúsculas para es-ES.
  return `${weekday} ${day} de ${month}`;
}

// ────────────────────────────────────────────────────────────────────────
// Wrappers HTML compartidos
// ────────────────────────────────────────────────────────────────────────

const STYLE = `
  body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f7f5f1; color: #2b2b2b; }
  .wrapper { width: 100%; padding: 24px 0; background: #f7f5f1; }
  .card { max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  .header { background: #4a5d4f; color: #ffffff; padding: 24px 28px; }
  .header h1 { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: 0.2px; }
  .body { padding: 28px; line-height: 1.55; font-size: 15px; }
  .body p { margin: 0 0 14px; }
  .body .slot { background: #f7f5f1; border-radius: 8px; padding: 14px 18px; margin: 18px 0; font-size: 15px; }
  .body .slot strong { color: #2b2b2b; }
  .btn { display: inline-block; background: #4a5d4f; color: #ffffff !important; text-decoration: none; padding: 12px 22px; border-radius: 8px; font-weight: 600; font-size: 14px; margin: 6px 0 18px; }
  .footer { padding: 18px 28px; color: #7a7a7a; font-size: 12px; text-align: center; background: #fafafa; }
  a { color: #4a5d4f; }
  ul { margin: 8px 0 14px; padding-left: 20px; }
  li { margin-bottom: 4px; }
  .muted { color: #7a7a7a; }
`;

function wrap(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrapper">
  <div class="card">
    <div class="header"><h1>${title}</h1></div>
    <div class="body">${bodyHtml}</div>
    <div class="footer">Agustina Chamut — Terapia online</div>
  </div>
</div>
</body>
</html>`;
}

// ────────────────────────────────────────────────────────────────────────
// 1. Email al cliente
// ────────────────────────────────────────────────────────────────────────

export interface ClientEmailInput {
  to: string;
  clientName: string;
  date: string;        // "YYYY-MM-DD" (Europe/Madrid)
  startTime: string;   // "HH:mm"
  endTime: string;     // "HH:mm"
  cancellationToken: string;
}

export async function sendBookingConfirmationToClient(
  input: ClientEmailInput
): Promise<void> {
  const client = getClient();
  const from = fromAddress();
  if (!client || !from) {
    console.warn(
      "[email] No se mandó confirmación al cliente: Resend o FROM_EMAIL no configurados"
    );
    return;
  }

  const cancelLink = `${publicUrl()}/cancelar?token=${encodeURIComponent(
    input.cancellationToken
  )}`;
  const wa = whatsappNumber();

  const bodyHtml = `
    <p>Hola <strong>${escapeHtml(input.clientName)}</strong>, tu turno está confirmado.</p>
    <div class="slot">
      <strong>${escapeHtml(humanDate(input.date))}</strong><br/>
      ${escapeHtml(input.startTime)}–${escapeHtml(input.endTime)} <span class="muted">(hora de España - Madrid)</span>
    </div>
    <p>Si necesitás cancelar, podés hacerlo hasta 24&nbsp;horas antes del turno desde este link:</p>
    <p><a class="btn" href="${cancelLink}">Cancelar mi turno</a></p>
    <p class="muted">Si el botón no funciona, copiá y pegá este link:<br/>
      <a href="${cancelLink}">${cancelLink}</a>
    </p>
    <p>Ante cualquier duda:</p>
    ${wa ? `<ul><li>WhatsApp: <a href="https://wa.me/${wa}">+${wa}</a></li><li>Email: <a href="mailto:${from}">${from}</a></li></ul>` : `<p><a href="mailto:${from}">${from}</a></p>`}
    <p>Nos vemos,<br/>Agustina</p>
  `;

  const subject = "✓ Turno confirmado – Agustina Chamut";

  const { error } = await client.emails.send({
    from,
    to: input.to,
    subject,
    html: wrap(subject, bodyHtml),
  });
  if (error) {
    throw new Error(`Resend (cliente): ${JSON.stringify(error)}`);
  }
}

// ────────────────────────────────────────────────────────────────────────
// 2. Email al admin (la terapeuta)
// ────────────────────────────────────────────────────────────────────────

export interface AdminEmailInput {
  to: string;
  clientName: string;
  clientPhone: string;
  clientEmail: string;
  notes: string | null;
  date: string;
  startTime: string;
  endTime: string;
}

export async function sendBookingNotificationToAdmin(
  input: AdminEmailInput
): Promise<void> {
  const to = input.to || adminEmail();
  if (!to) {
    console.warn(
      "[email] No se mandó notificación al admin: ADMIN_EMAIL no configurado"
    );
    return;
  }
  const client = getClient();
  const from = fromAddress();
  if (!client || !from) {
    console.warn(
      "[email] No se mandó notificación al admin: Resend o FROM_EMAIL no configurados"
    );
    return;
  }

  const adminLink = `${publicUrl()}/admin`;
  const notesHtml = input.notes
    ? `<p><strong>Notas del cliente:</strong><br/>${escapeHtml(input.notes)}</p>`
    : `<p class="muted">El cliente no dejó notas.</p>`;

  const bodyHtml = `
    <p>Nueva reserva confirmada.</p>
    <div class="slot">
      <strong>${escapeHtml(input.clientName)}</strong><br/>
      <span class="muted">${escapeHtml(input.clientPhone)} · <a href="mailto:${escapeHtml(input.clientEmail)}">${escapeHtml(input.clientEmail)}</a></span>
    </div>
    <div class="slot">
      <strong>${escapeHtml(humanDate(input.date))}</strong><br/>
      ${escapeHtml(input.startTime)}–${escapeHtml(input.endTime)} <span class="muted">(hora de España - Madrid)</span>
    </div>
    ${notesHtml}
    <p><a class="btn" href="${adminLink}">Ir al panel admin</a></p>
  `;

  const subject = `Nueva reserva – ${input.clientName}`;

  const { error } = await client.emails.send({
    from,
    to,
    subject,
    html: wrap(subject, bodyHtml),
  });
  if (error) {
    throw new Error(`Resend (admin): ${JSON.stringify(error)}`);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Util
// ────────────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
