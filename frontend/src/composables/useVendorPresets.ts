import { ref } from 'vue';
import { getVendorPresetUrls } from '@/api/vendor';

type PresetUrls = Record<string, Record<string, string>>;

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

    return { presetUrls, load };
}
