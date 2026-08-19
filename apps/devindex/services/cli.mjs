import dotenv    from 'dotenv';
import Neo       from '../../../node_modules/neo.mjs/src/Neo.mjs';
import * as core from '../../../node_modules/neo.mjs/src/core/_export.mjs';
import Manager   from './Manager.mjs';

dotenv.config({quiet: true});

async function start() {
    await Manager.ready();
}

start().catch(console.error);
