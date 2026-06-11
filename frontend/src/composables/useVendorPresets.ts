import { ref, computed } from 'vue';
import { getVendorPresetUrls } from '@/api/vendor';

export type VendorPreset = { label?: string } & Record<string, string>;
export type PresetUrls = Record<string, VendorPreset>;

const presetUrls = ref<PresetUrls>({});
let loadPromise: Promise<void> | null = null;

export function useVendorPresets() {
    function load(): Promise<void> {
        if (!loadPromise) {
            loadPromise = getVendorPresetUrls()
                .then(data => { presetUrls.value = data; })
                .catch(() => { loadPromise = null; });
        }
        return loadPromise;
    }

    const vendorTypeOptions = computed(() =>
        Object.entries(presetUrls.value).map(([value, preset]) => ({
            value,
            label: preset.label ?? value,
        })),
    );

    return { presetUrls, vendorTypeOptions, load };
}
