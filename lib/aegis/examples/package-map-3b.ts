// Display-only fallback for recorded examples.
// Values reproduce the 3b artboard. Never persist them, export them, or use them as evidence.
export const EXAMPLE_PROVIDER={id:'LA-EXAMPLE',title:'AWS GovCloud · FedRAMP High',short:'AWS GovCloud',example:true};
export const EXAMPLE_PARTIAL=new Set(['SC-7','SC-8','SC-12','SC-28','AU-9','CM-8','SI-2','SI-4','CP-9']);
export const EXAMPLE_COMPONENTS:Record<string,string[]>={AC:['Identity provider'],IA:['Identity provider'],CM:['Kubernetes platform'],SI:['Kubernetes platform'],AU:['Kubernetes platform'],SC:['Kubernetes platform'],RA:['Kubernetes platform'],SA:['Application'],CA:['Program office'],PL:['Program office'],SR:['Program office'],PM:['Program office'],PS:['Program office'],AT:['Program office'],IR:['Program office'],CP:['Program office']};
export const EXAMPLE_EXTRA:Record<string,string[]>={'AC-3':['Application'],'SI-2':['Application'],'AU-2':['Application'],'AU-3':['Application'],'SC-8':['Application'],'CM-3':['Program office'],'RA-5':['Program office']};
export const EXAMPLE_ROLES=[
  {
    "id": "system-owner",
    "title": "System Owner",
    "shortName": "System Owner"
  },
  {
    "id": "isso",
    "title": "Information System Security Officer",
    "shortName": "ISSO"
  },
  {
    "id": "system-admin",
    "title": "System Administrator",
    "shortName": "System Admin"
  },
  {
    "id": "secops",
    "title": "Security Operations",
    "shortName": "Security Ops"
  },
  {
    "id": "identity-admin",
    "title": "Identity and Access Administrator",
    "shortName": "Identity Admin"
  }
];
export const EXAMPLE_OWNERS:Record<string,string[]>={
  "AC-2": [
    "identity-admin",
    "system-owner"
  ],
  "AC-3": [
    "identity-admin"
  ],
  "AC-6": [
    "identity-admin",
    "isso"
  ],
  "AU-2": [],
  "AU-6": [
    "secops",
    "isso"
  ],
  "CM-2": [
    "system-admin",
    "system-owner"
  ],
  "CM-6": [
    "system-admin",
    "isso"
  ],
  "IA-2": [
    "identity-admin"
  ],
  "IA-5": [
    "identity-admin",
    "system-admin"
  ],
  "SC-7": [
    "system-admin",
    "secops"
  ],
  "SC-8": [
    "system-admin"
  ],
  "SI-2": [
    "system-admin",
    "secops"
  ]
};
