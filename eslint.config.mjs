import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  {ignores:['node_modules/**','dist/**','apps/web/.next/**','apps/web/next-env.d.ts','test-results/**','playwright-report/**']},
  js.configs.recommended,...tseslint.configs.recommended,
  {languageOptions:{globals:{process:'readonly',console:'readonly',Buffer:'readonly',URL:'readonly',fetch:'readonly',Response:'readonly',AbortSignal:'readonly',setTimeout:'readonly',clearTimeout:'readonly',setInterval:'readonly',clearInterval:'readonly',structuredClone:'readonly',window:'readonly',document:'readonly',history:'readonly',sessionStorage:'readonly',navigator:'readonly',crypto:'readonly',location:'readonly',Event:'readonly',EventTarget:'readonly',URLSearchParams:'readonly'}},
   rules:{'@typescript-eslint/no-explicit-any':'error','@typescript-eslint/no-unused-vars':['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_'}],'no-undef':'off'}}
);
