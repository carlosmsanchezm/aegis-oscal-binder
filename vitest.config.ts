import {defineConfig} from "vitest/config";
import {fileURLToPath} from "node:url";
export default defineConfig({oxc:{jsx:{runtime:"classic"}},test:{projects:[{extends:true,test:{name:"logic",include:["test/*.vitest.ts"],environment:"node"}},{extends:true,test:{name:"components",include:["test/components/*.vitest.tsx"],environment:"happy-dom",setupFiles:["./test/components/setup.ts"]}}]},resolve:{alias:{"@":fileURLToPath(new URL(".",import.meta.url))}}});
