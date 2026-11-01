import { createApp } from './app.module';
import { loadConfig } from './config';

const config = loadConfig();
const app = await createApp(config);
await app.listen(config.port, '0.0.0.0');
