import { describe, it, expect, beforeAll } from 'vitest';
import requestHelper from '../../helpers/requestHelper';
import dbHelper from '../../helpers/dbHelper';
import modelFixtures from '../../fixtures/modelFixtures';

describe('Batch API', () => {
    let rootToken = 'root-token-123';

    beforeAll(async () => {
        await dbHelper.truncate();
    });

    describe('User Batch', () => {
        it('should fetch multiple users by IDs', async () => {
            const user1 = await requestHelper.post('/user/create.json', { name: 'User 1' }, rootToken);
            const user2 = await requestHelper.post('/user/create.json', { name: 'User 2' }, rootToken);

            const response = await requestHelper.post('/user/batch.json', { 
                ids: [user1.body.id, user2.body.id] 
            }, rootToken);

            expect(response.status).toBe(200);
            expect(response.body).toHaveLength(2);
            const names = response.body.map((u: any) => u.name);
            expect(names).toContain('User 1');
            expect(names).toContain('User 2');
        });

        it('should return empty array for empty IDs', async () => {
            const response = await requestHelper.post('/user/batch.json', { ids: [] }, rootToken);
            expect(response.status).toBe(200);
            expect(response.body).toEqual([]);
        });
    });

    describe('Vendor Batch', () => {
        it('should fetch multiple vendors by IDs', async () => {
            const vendor1 = await requestHelper.post('/vendor/create.json', { 
                type: 'openai', name: 'Vendor 1', token: 'token1' 
            }, rootToken);
            const vendor2 = await requestHelper.post('/vendor/create.json', { 
                type: 'anthropic', name: 'Vendor 2', token: 'token2' 
            }, rootToken);

            const response = await requestHelper.post('/vendor/batch.json', { 
                ids: [vendor1.body.id, vendor2.body.id] 
            }, rootToken);

            expect(response.status).toBe(200);
            expect(response.body).toHaveLength(2);
            const names = response.body.map((v: any) => v.name);
            expect(names).toContain('Vendor 1');
            expect(names).toContain('Vendor 2');
        });
    });

    describe('Model Batch', () => {
        it('should fetch multiple models by IDs', async () => {
            const vendor = await requestHelper.post('/vendor/create.json', { 
                type: 'openai', name: 'Model Vendor', token: 'token' 
            }, rootToken);

            const model1 = await requestHelper.post(
                '/model/create.json',
                modelFixtures.createRandomModel(vendor.body.id, 'Model 1'),
                rootToken,
            );
            const model2 = await requestHelper.post(
                '/model/create.json',
                modelFixtures.createRandomModel(vendor.body.id, 'Model 2'),
                rootToken,
            );

            const response = await requestHelper.post('/model/batch.json', { 
                ids: [model1.body.id, model2.body.id] 
            }, rootToken);

            expect(response.status).toBe(200);
            expect(response.body).toHaveLength(2);
            const names = response.body.map((m: any) => m.name);
            expect(names).toContain('Model 1');
            expect(names).toContain('Model 2');
        });
    });
});
