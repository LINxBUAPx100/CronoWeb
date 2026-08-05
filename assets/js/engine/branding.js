/**
 * Planes y resolución de branding — puerto JS de `backend/app/core/{config,branding}.py`.
 *
 * El gating vive en UN solo lugar por motor. Hoy el navegador siempre corre en
 * plan `free` (el modo personalizado se desbloquea con licencia contra el backend),
 * pero la tabla completa está aquí para que activar el cobro sea cambiar el plan
 * que devuelve `resolvePlanKey`, no reescribir la app.
 *
 * @module engine/branding
 */

export const WATERMARK_TEXT = 'CronoWeb.com';

export const PLAN_FEATURES = Object.freeze({
  free: {
    key: 'free',
    label: 'Modo simple',
    price_mxn_year: 0,
    custom_branding: false,
    remove_watermark: false,
    max_groups: 12,
    max_teachers: 40,
    max_time_budget_seconds: 10,
    persistence: false,
    api_access: false,
  },
  school: {
    key: 'school',
    label: 'Escuela',
    price_mxn_year: 1800,
    custom_branding: true,
    remove_watermark: false,
    max_groups: 60,
    max_teachers: 200,
    max_time_budget_seconds: 60,
    persistence: true,
    api_access: false,
  },
  zone: {
    key: 'zone',
    label: 'Zona escolar',
    price_mxn_year: 12000,
    custom_branding: true,
    remove_watermark: false,
    max_groups: 600,
    max_teachers: 2000,
    max_time_budget_seconds: 120,
    persistence: true,
    api_access: true,
  },
});

export const planFeatures = (plan) => PLAN_FEATURES[String(plan || 'free').toLowerCase()] || PLAN_FEATURES.free;

/**
 * Resuelve el branding efectivo. Regla de negocio: la marca de agua CronoWeb.com
 * nunca desaparece del PNG; en modo personalizado baja a crédito discreto.
 * @returns {{resolved:object, conflicts:object[]}}
 */
export function resolveBranding(branding, plan) {
  const features = planFeatures(plan);
  const conflicts = [];
  const wantsCustom = branding?.mode === 'custom';
  const allowCustom = wantsCustom && features.custom_branding;
  const downgraded = wantsCustom && !features.custom_branding;

  if (downgraded) {
    conflicts.push({
      severity: 'info',
      code: 'BRANDING_DOWNGRADED',
      message: `El plan «${features.label}» no incluye personalización; el horario se generó en ` +
        'modo simple con marca de agua CronoWeb.com.',
      group_id: null, subject_id: null, teacher_id: null, missing_hours: null,
    });
  }

  const resolved = allowCustom
    ? {
      mode: 'custom',
      plan: features.key,
      school_name: branding.school_name || null,
      logo_data_url: branding.logo_data_url || null,
      primary_color: branding.primary_color || '#0f766e',
      cycle_label: branding.cycle_label || null,
      footer_note: branding.footer_note || null,
      show_logo: Boolean(branding.logo_data_url),
      watermark_text: WATERMARK_TEXT,
      watermark_required: !features.remove_watermark,
      downgraded: false,
    }
    : {
      // Modo simple: se descarta todo dato de identidad de la escuela.
      mode: 'simple',
      plan: features.key,
      school_name: null,
      logo_data_url: null,
      primary_color: '#0f766e',
      cycle_label: branding?.cycle_label || null,
      footer_note: null,
      show_logo: false,
      watermark_text: WATERMARK_TEXT,
      watermark_required: true,
      downgraded,
    };

  return { resolved, conflicts };
}
