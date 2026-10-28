import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

export default defineConfig({
  base: './',
  plugins: [
    {
      name: 'copy-car-packs',
      closeBundle() {
        const packs = [
          'orchids_simulator_traffic_car_pack',
          'traffic_racer_npc_vehicles_pack',
        ];
        for (const pack of packs) {
          const src = path.resolve(pack);
          const dest = path.resolve('dist', pack);
          if (fs.existsSync(src)) {
            fs.cpSync(src, dest, { recursive: true });
          }
        }
      },
    },
  ],
});
