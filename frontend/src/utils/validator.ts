import { message } from 'ant-design-vue/es';

export interface ValidationRule {
    required?: boolean;
    message?: string;
    pattern?: RegExp;
    validator?: (value: unknown) => boolean | string;
}

export interface ValidationResult {
    valid: boolean;
    error?: string;
}

export function validate(value: unknown, rules: ValidationRule[]): ValidationResult {
    for (const rule of rules) {
        if (rule.required && (value === null || value === undefined || value === '')) {
            return {
                valid: false,
                error: rule.message || '该字段不能为空',
            };
        }

        if (rule.pattern && (typeof value !== 'string' || !rule.pattern.test(value))) {
            return {
                valid: false,
                error: rule.message || '格式不正确',
            };
        }

        if (rule.validator) {
            const result = rule.validator(value);
            if (result !== true) {
                return {
                    valid: false,
                    error: typeof result === 'string' ? result : rule.message || '验证失败',
                };
            }
        }
    }

    return { valid: true };
}

export function showValidationErrors(errors: string[]): void {
    errors.forEach((error) => {
        message.error(error);
    });
}
