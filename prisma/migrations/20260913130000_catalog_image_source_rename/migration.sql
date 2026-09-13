-- Rename enum value: la imagen de catálogo autogenerada se renderiza a
-- partir de datos reales del catálogo, no por un modelo de IA generativo.
ALTER TYPE "CatalogImageSource" RENAME VALUE 'AI_GENERATED' TO 'GENERATED';
