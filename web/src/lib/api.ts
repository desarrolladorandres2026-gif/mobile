const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';

export interface LegalDocument {
  _id: string;
  kind: string;
  version: string;
  title: string;
  content: string;
  effectiveAt: string;
}

export async function getLegalDocuments(): Promise<LegalDocument[]> {
  const res = await fetch(`${API_URL}/legal/documents`);
  if (!res.ok) throw new Error('No se pudieron cargar los documentos legales');
  const body = await res.json();
  return body.data as LegalDocument[];
}
