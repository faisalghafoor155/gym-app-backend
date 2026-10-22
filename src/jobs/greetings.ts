import { Prisma, type GreetingKind } from '@prisma/client';
import prisma from '../db.js';
import { celebrationsOn, type Celebrant } from '../services/celebrations.js';
import { canWhatsApp } from '../services/phone.js';
import { planHasFeature } from '../services/subscription.js';
import { sendWhatsApp, templates, whatsappEnabled } from '../services/whatsapp.js';

/**
 * Birthday and joining-anniversary greetings, on WhatsApp.
 *
 * Once a year per member per kind, enforced by GreetingLog's unique key rather
 * than by trusting the job to run once: a restart at ten past nine must not
 * wish somebody happy birthday twice.
 *
 * Off with `GREETINGS_ENABLED=false`. Greetings are the one message here a gym
 * might reasonably not want to send at all, and unlike a receipt nobody is
 * worse off without one.
 */

const enabled = (): boolean => process.env.GREETINGS_ENABLED !== 'false';

export interface GreetingRun {
  birthdays: number;
  anniversaries: number;
  sent: number;
  skippedAlreadySent: number;
  skippedNoWhatsApp: number;
  failed: number;
}

const emptyRun = (): GreetingRun => ({
  birthdays: 0,
  anniversaries: 0,
  sent: 0,
  skippedAlreadySent: 0,
  skippedNoWhatsApp: 0,
  failed: 0,
});

const claim = async (
  m: Celebrant, kind: GreetingKind, year: number, sentTo: string,
): Promise<boolean> => {
  try {
    await prisma.greetingLog.create({
      data: { gymId: m.gymId, memberId: m.id, kind, channel: 'whatsapp', year, sentTo },
    });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false;
    throw err;
  }
};

const greet = async (
  m: Celebrant,
  kind: GreetingKind,
  year: number,
  message: ReturnType<typeof templates.birthdayGreeting>,
  run: GreetingRun,
): Promise<void> => {
  if (!planHasFeature(m.gym.plan, 'whatsapp')) return;
  if (m.whatsappOptOut || !canWhatsApp(m.phone)) {
    run.skippedNoWhatsApp++;
    return;
  }
  if (!(await claim(m, kind, year, m.phone!))) {
    run.skippedAlreadySent++;
    return;
  }

  const result = await sendWhatsApp({ to: m.phone!, ...message });
  if (result === 'sent') {
    run.sent++;
    return;
  }

  run.failed++;
  // Released so a later run today can try again. Tomorrow's cannot — the
  // day will have passed — so the window for a retry is the rest of today.
  await prisma.greetingLog.deleteMany({
    where: { memberId: m.id, kind, year, channel: 'whatsapp' },
  });
};

export const runGreetings = async (now: Date = new Date()): Promise<GreetingRun> => {
  const run = emptyRun();
  if (!enabled()) return run;

  const { birthdays, anniversaries } = await celebrationsOn(now);
  run.birthdays = birthdays.length;
  run.anniversaries = anniversaries.length;
  if (!whatsappEnabled) return run;

  const year = now.getFullYear();
  for (const m of birthdays) {
    await greet(m, 'birthday', year, templates.birthdayGreeting(m.name, m.gym.name), run);
  }
  for (const m of anniversaries) {
    await greet(
      m, 'anniversary', year,
      templates.anniversaryGreeting(m.name, m.gym.name, String(m.years)),
      run,
    );
  }

  return run;
};
