import type { SharedChatSession } from './api';

const POSTER_WIDTH = 1080;
const POSTER_HEIGHT = 1440;
const DISPLAY_FONT = '"Kaiti SC", "STKaiti", "KaiTi", "Songti SC", serif';
const TEXT_FONT = '"PingFang SC", "Microsoft YaHei", sans-serif';
const INK = '#292722';
const MUTED = '#81786c';
const PAPER = '#faf7ef';
const ACCENT = '#a53a42';

export interface SharePosterCopy {
  appName: string;
  nature: string;
  systems: string;
  questionLabel: string;
  scanTitle: string;
  scanHint: string;
}

export function getShareQuestion(session: SharedChatSession): string {
  // Direct chart requests contain birth details rather than the user's question.
  const question = session.messages
    .filter(
      (message) =>
        !message.is_bot_message &&
        message.metadata?.kind !== 'board_request' &&
        message.content.trim(),
    )
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))[0];
  return question?.content.trim() || session.title.trim();
}

export function wrapPosterText(
  text: string,
  maxWidth: number,
  maxLines: number,
  measure: (value: string) => number,
): { lines: string[]; truncated: boolean } {
  const graphemes = Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
      text.replace(/\s+/g, ' ').trim(),
    ),
    (segment) => segment.segment,
  );
  const lines: string[] = [];
  let line = '';
  for (const grapheme of graphemes) {
    if (line && measure(line + grapheme) > maxWidth) {
      lines.push(line.trim());
      if (lines.length === maxLines) {
        const lastLine = Array.from(
          new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
            lines[maxLines - 1],
          ),
          (segment) => segment.segment,
        );
        while (lastLine.length && measure(lastLine.join('') + '…') > maxWidth) {
          lastLine.pop();
        }
        lines[maxLines - 1] = lastLine.join('').trimEnd() + '…';
        return { lines, truncated: true };
      }
      line = grapheme.trimStart();
    } else {
      line += grapheme;
    }
  }
  if (line) lines.push(line.trim());
  return { lines, truncated: false };
}

function drawSeal(context: CanvasRenderingContext2D) {
  context.fillStyle = ACCENT;
  context.beginPath();
  context.roundRect(92, 96, 96, 96, 18);
  context.fill();
  context.save();
  context.translate(140, 144);
  context.scale(3.1, 3.1);
  context.strokeStyle = PAPER;
  context.fillStyle = PAPER;
  context.lineWidth = 1.25;
  context.beginPath();
  context.arc(0, 0, 10, 0, Math.PI * 2);
  context.stroke();
  context.beginPath();
  context.arc(0, 0, 10, -Math.PI / 2, Math.PI / 2);
  context.arc(0, 5, 5, Math.PI / 2, -Math.PI / 2);
  context.arc(0, -5, 5, Math.PI / 2, -Math.PI / 2, true);
  context.fill();
  context.beginPath();
  context.arc(0, -5, 1.6, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = ACCENT;
  context.beginPath();
  context.arc(0, 5, 1.6, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawTrigrams(context: CanvasRenderingContext2D) {
  context.save();
  context.translate(1000, 300);
  context.strokeStyle = ACCENT;
  context.globalAlpha = 0.075;
  context.lineWidth = 2;
  for (const radius of [190, 274]) {
    context.beginPath();
    context.arc(0, 0, radius, 0, Math.PI * 2);
    context.stroke();
  }
  const trigrams = [7, 3, 2, 1, 0, 4, 5, 6];
  for (let trigram = 0; trigram < trigrams.length; trigram += 1) {
    context.save();
    context.rotate((trigram * Math.PI) / 4);
    for (let line = 0; line < 3; line += 1) {
      const y = -247 + line * 13;
      context.lineWidth = 5;
      context.beginPath();
      if ((trigrams[trigram] >> line) & 1) {
        context.moveTo(-23, y);
        context.lineTo(23, y);
      } else {
        context.moveTo(-23, y);
        context.lineTo(-5, y);
        context.moveTo(5, y);
        context.lineTo(23, y);
      }
      context.stroke();
    }
    context.restore();
  }
  context.restore();
}

export async function renderSharePoster({
  question,
  url,
  copy,
}: {
  question: string;
  url: string;
  copy: SharePosterCopy;
}): Promise<Blob> {
  const { default: QRCode } = await import('qrcode');
  const canvas = document.createElement('canvas');
  canvas.width = POSTER_WIDTH;
  canvas.height = POSTER_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas unavailable');

  context.fillStyle = PAPER;
  context.fillRect(0, 0, POSTER_WIDTH, POSTER_HEIGHT);
  context.strokeStyle = '#ded6c6';
  context.lineWidth = 2;
  context.strokeRect(35, 35, POSTER_WIDTH - 70, POSTER_HEIGHT - 70);
  drawTrigrams(context);
  drawSeal(context);

  context.textBaseline = 'top';
  context.fillStyle = INK;
  context.font = `600 46px ${DISPLAY_FONT}`;
  context.fillText(copy.appName, 212, 105, 650);
  context.font = `19px ${TEXT_FONT}`;
  context.fillStyle = MUTED;
  context.fillText('FATECLAW', 215, 166);

  context.fillStyle = ACCENT;
  context.font = `500 39px ${DISPLAY_FONT}`;
  context.fillText(copy.nature, 94, 261, 880);
  context.fillStyle = MUTED;
  context.font = `22px ${TEXT_FONT}`;
  context.fillText(copy.systems, 96, 321, 880);

  context.fillStyle = ACCENT;
  context.fillRect(96, 428, 32, 3);
  context.font = `22px ${TEXT_FONT}`;
  context.fillText(copy.questionLabel, 145, 416, 750);

  let fontSize = 76;
  let layout = { lines: [] as string[], truncated: false };
  for (const size of [76, 68, 60, 52, 46, 40]) {
    fontSize = size;
    context.font = `500 ${fontSize}px ${DISPLAY_FONT}`;
    layout = wrapPosterText(
      question,
      870,
      Math.floor(520 / (size * 1.45)),
      (value) => context.measureText(value).width,
    );
    if (!layout.truncated) break;
  }
  context.fillStyle = INK;
  layout.lines.forEach((line, index) => {
    context.fillText(line, 94, 485 + index * fontSize * 1.45);
  });

  context.fillStyle = '#efe9dd';
  context.fillRect(72, 1050, 936, 306);
  context.fillStyle = ACCENT;
  context.fillRect(72, 1050, 4, 306);
  context.fillStyle = INK;
  context.font = `500 34px ${DISPLAY_FONT}`;
  context.fillText(copy.scanTitle, 110, 1110, 560);
  context.fillStyle = MUTED;
  context.font = `22px ${TEXT_FONT}`;
  context.fillText(copy.scanHint, 112, 1168, 560);
  context.font = `20px ${TEXT_FONT}`;
  context.fillText(new URL(url).host, 112, 1272, 560);

  const qr = await QRCode.toCanvas(url, {
    errorCorrectionLevel: 'M',
    margin: 4,
    scale: 6,
    color: { dark: '#292722', light: '#ffffff' },
  });
  context.imageSmoothingEnabled = false;
  context.drawImage(qr, 720, 1080, 246, 246);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PNG export failed'));
    }, 'image/png');
  });
}
