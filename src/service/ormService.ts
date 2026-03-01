import { sutando } from 'sutando';
import { DatabaseAdapter, D1Adapter, SQLiteAdapter } from './dbAdapter';

export interface ORMOptions {
  mode: 'cloud' | 'local';
  dbPath?: string;
}

class ORMService {
  private _dbAdapter: DatabaseAdapter | null = null;
  public mode: 'cloud' | 'local' = 'cloud';

  async init(options: ORMOptions): Promise<DatabaseAdapter> {
    const { mode, dbPath } = options;
    this.mode = mode;

    if (mode === 'cloud') {
      this._dbAdapter = new D1Adapter();
    } else {
      if (!dbPath) {
        throw new Error('dbPath is required for local mode');
      }
      const Database = (await import('better-sqlite3')).default;
      
      sutando.addConnection({
        client: 'better-sqlite3',
        connection: {
          filename: dbPath,
        },
        useNullAsDefault: true,
      });
      
      const db = new Database(dbPath);
      this._dbAdapter = new SQLiteAdapter(db);
    }
    
    return this._dbAdapter;
  }

  private _cloudConnected = false;

  async connectCloud(db: any) {
    if (this._dbAdapter instanceof D1Adapter) {
      this._dbAdapter.setDB(db);
    }

    if (!this._cloudConnected) {
      const ClientD1 = (await import('knex-cloudflare-d1')).default;
      
      sutando.addConnection({
        client: ClientD1,
        connection: {
          database: db
        },
        useNullAsDefault: true
      });
      this._cloudConnected = true;
    }
  }

  async prepareDBConnection(db: any) {
    if (this.mode === 'cloud') {
      await this.connectCloud(db);
    }
  }

  get dbAdapter(): DatabaseAdapter {
    if (!this._dbAdapter) {
      throw new Error('ORMService not initialized');
    }
    return this._dbAdapter;
  }
}

export const ormService = new ORMService();
