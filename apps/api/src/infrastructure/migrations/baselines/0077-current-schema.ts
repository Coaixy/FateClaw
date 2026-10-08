import { readFileSync } from 'node:fs';

import type { DatabaseBaseline } from '../types.js';

export const currentSchemaBaseline: DatabaseBaseline = {
  throughMigrationId: '0077_drop_bazi_cases',
  async up(client) {
    const sql = readFileSync(
      new URL('./0077-current-schema.sql', import.meta.url),
      'utf8',
    );
    await client.query(sql);
  },
};
