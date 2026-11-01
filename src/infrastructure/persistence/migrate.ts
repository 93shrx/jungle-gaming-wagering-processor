import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from './orm-config';

const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  console.error('usage: migrate.ts <up|down>');
  process.exit(2);
}

const orm = await MikroORM.init(buildOrmConfig({ poolMax: 2 }));
try {
  const migrator = orm.migrator;
  const result = direction === 'up' ? await migrator.up() : await migrator.down();
  console.log(`migration ${direction}: ${result.length ? result.map((m) => m.name).join(', ') : 'nothing to do'}`);
} finally {
  await orm.close();
}
