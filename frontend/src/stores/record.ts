import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { listRecords, latestRecords, getRecord } from '@/api/record';
import { getUser, fetchUsersByIds } from '@/api/user';
import { getModel, fetchModelsByIds } from '@/api/model';
import { getVendor, fetchVendorsByIds } from '@/api/vendor';
import type { Record, RecordQuery, RecordDetail } from '@/types/record';


export const useRecordStore = defineStore('record', () => {
    // State
    const records = ref<Record[]>([]);
    const currentRecord = ref<RecordDetail | null>(null);
    const total = ref(0);
    const loading = ref(false);

    // Getters
    const hasRecords = computed(() => records.value.length > 0);

    // Actions
    async function fetchRecords(query?: RecordQuery): Promise<{ total: number }> {
        loading.value = true;
        try {
            const response = await listRecords(query);
            const fetchedRecords = response.list || [];
            total.value = response.total || 0;

            if (fetchedRecords.length > 0) {
                // 批量获取关联信息
                await enrichRecords(fetchedRecords);
            }
            
            records.value = fetchedRecords;
            return { total: total.value };
        } catch (error) {
            console.error('获取记录列表失败:', error);
            records.value = [];
            total.value = 0;
            return { total: 0 };
        } finally {
            loading.value = false;
        }
    }

    async function fetchLatest(limit: number = 10): Promise<void> {
        loading.value = true;
        try {
            const response = await latestRecords(limit);
            const fetchedRecords = response || [];
            
            if (fetchedRecords.length > 0) {
                await enrichRecords(fetchedRecords);
            }
            
            records.value = fetchedRecords;
        } catch (error) {
            console.error('获取最新记录失败:', error);
            records.value = [];
        } finally {
            loading.value = false;
        }
    }

    /**
     * 为记录列表填充关联名称（用户、模型、供应商）
     */
    async function enrichRecords(recordList: Record[]) {
        const userIds = [...new Set(recordList.map(r => r.user_id).filter(id => id !== null && Number(id) !== -1))] as number[];
        const modelIds = [...new Set(recordList.map(r => r.model_id).filter(id => id !== null))] as number[];

        const [users, models] = await Promise.all([
            userIds.length > 0 ? fetchUsersByIds(userIds) : Promise.resolve([]),
            modelIds.length > 0 ? fetchModelsByIds(modelIds) : Promise.resolve([]),
        ]);

        const userMap = new Map(users.map(u => [Number(u.id), u.name]));
        const modelMap = new Map(models.map(m => [Number(m.id), m]));

        // 获取供应商信息 (基于记录自身的 vendor_id)
        const vendorIds = [...new Set(recordList.map(r => r.vendor_id).filter(id => id !== null && id !== undefined))] as number[];
        const vendors = vendorIds.length > 0 ? await fetchVendorsByIds(vendorIds) : [];
        const vendorMap = new Map(vendors.map(v => [Number(v.id), v.name]));

        recordList.forEach(record => {
            const uid = record.user_id !== null ? Number(record.user_id) : null;
            const mid = record.model_id !== null ? Number(record.model_id) : null;

            if (uid === -1) {
                record.user_name = 'root';
            } else if (uid) {
                record.user_name = userMap.get(uid) || `用户${uid}`;
            }

            if (mid) {
                const model = modelMap.get(mid);
                if (model) {
                    record.model_name = model.name;
                } else {
                    record.model_name = `模型${mid}`;
                }
            }

            if (record.vendor_id) {
                const vid = Number(record.vendor_id);
                record.vendor_name = vendorMap.get(vid) || `供应商${vid}`;
            } else {
                record.vendor_name = null;
            }
            
            // vendor_model_name 已经由后端直接返回，不需要单独再映射
        });
    }

    async function fetchRecordDetail(id: number): Promise<void> {
        loading.value = true;
        currentRecord.value = null;
        try {
            const record = await getRecord(id);

            // 准备详情数据
            const recordDetail: RecordDetail = {
                ...record,
                user_name: null,
                model_name: null,
                vendor_name: null,
                vendor_model_name: null,
            };

            // 并行查询用户和模型信息
            const promises: Promise<void>[] = [];

            if (record.user_id === -1) {
                recordDetail.user_name = 'root';
            } else if (record.user_id) {
                promises.push(
                    getUser(record.user_id).then(user => {
                        recordDetail.user_name = user.name;
                    }).catch(() => {
                        recordDetail.user_name = `用户${record.user_id}`;
                    })
                );
            }

            if (record.model_id) {
                promises.push(
                    getModel(record.model_id).then(async model => {
                        recordDetail.model_name = model.name;
                    }).catch(() => {
                        recordDetail.model_name = `模型${record.model_id}`;
                    })
                );
            }
            
            if (record.vendor_id) {
                promises.push(
                    getVendor(record.vendor_id).then(vendor => {
                        recordDetail.vendor_name = vendor.name;
                    }).catch(() => {
                        recordDetail.vendor_name = `供应商${record.vendor_id}`;
                    })
                );
            }

            await Promise.all(promises);
            currentRecord.value = recordDetail;
        } catch (error) {
            console.error('获取记录详情失败:', error);
            currentRecord.value = null;
        } finally {
            loading.value = false;
        }
    }

    function clearCurrentRecord(): void {
        currentRecord.value = null;
    }

    function clearRecords(): void {
        records.value = [];
        total.value = 0;
    }

    return {
        records,
        currentRecord,
        total,
        loading,
        hasRecords,
        fetchRecords,
        fetchLatest,
        enrichRecords,
        fetchRecordDetail,
        clearCurrentRecord,
        clearRecords,
    };
});
