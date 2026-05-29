"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent, WheelEvent } from "react";
import { geoGraticule10, geoNaturalEarth1, geoPath } from "d3-geo";
import { MapPinned } from "lucide-react";
import { feature } from "topojson-client";
import { useTranslation } from "react-i18next";

import type { NodeBasicInfo } from "@/contexts/NodeListContext";
import type { LiveData } from "@/types/LiveData";
import worldCountries50m from "@/data/world-countries-50m.json";
import { buildMapViewSummary, type MapRegionSummary } from "@/utils/mapRegions";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import Flag from "@/components/Flag";

import "./NodeMapView.css";

interface NodeMapViewProps {
  nodes: NodeBasicInfo[];
  liveData: LiveData;
  mapOnly?: boolean;
}

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;
type HoveredRegion = {
  regionKey: string;
  x: number;
  y: number;
  horizontal: "left" | "right";
  vertical: "above" | "below";
};
type HoveredServerPin = {
  pinKey: string;
  x: number;
  y: number;
  horizontal: "left" | "right";
  vertical: "above" | "below";
};
type MapTransform = {
  scale: number;
  x: number;
  y: number;
};
type ServerPin = {
  key: string;
  node: NodeBasicInfo;
  region: MapRegionSummary;
  city: string;
  x: number;
  y: number;
  online: boolean;
  cityTotal: number;
  cityOnline: number;
  cityOffline: number;
};

const SVG_WIDTH = 1000;
const SVG_HEIGHT = 560;
const MAP_HORIZONTAL_PADDING = 28;
const MAP_TOP_PADDING = 42;
const MAP_BOTTOM_INSET = 42;
const SMALL_REGION_MARKER_AREA_THRESHOLD = 14;
const SMALL_REGION_MARKER_SIZE_THRESHOLD = 7;
const HOVER_CARD_GAP = 12;
const HOVER_CARD_MAX_WIDTH = 320;
const HOVER_CARD_FALLBACK_HEIGHT = 124;
const HOVER_CARD_EDGE_PADDING = 8;
const MAP_ZOOM_MIN = 1;
const MAP_ZOOM_MAX = 5;

const FALLBACK_CITY_COORDS: Record<string, { city: string; coord: [number, number] }> = {
  US: { city: "Washington", coord: [-98.58, 39.83] },
  DE: { city: "Berlin", coord: [10.45, 51.16] },
  HK: { city: "Hong Kong", coord: [114.17, 22.32] },
  CH: { city: "Bern", coord: [8.23, 46.82] },
  IE: { city: "Dublin", coord: [-8.24, 53.41] },
  SG: { city: "Singapore", coord: [103.82, 1.35] },
  JP: { city: "Tokyo", coord: [138.25, 36.2] },
  CN: { city: "Beijing", coord: [104.2, 35.86] },
  GB: { city: "London", coord: [-3.44, 55.38] },
  FR: { city: "Paris", coord: [2.21, 46.23] },
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function getNodeCity(node: NodeBasicInfo, flagCode: string) {
  return (
    node.city ||
    node.location_city ||
    node.locationCity ||
    node.provider_city ||
    FALLBACK_CITY_COORDS[flagCode]?.city ||
    flagCode
  );
}

function getNodeLonLat(node: NodeBasicInfo, flagCode: string): [number, number] | null {
  const lat = Number(node.latitude ?? node.lat);
  const lon = Number(node.longitude ?? node.lon ?? node.lng);

  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return [lon, lat];
  }

  return FALLBACK_CITY_COORDS[flagCode]?.coord ?? null;
}

function getStatusText(t: TranslateFn, status: "online" | "offline" | "partial") {
  switch (status) {
    case "online":
      return t("mapView.status.online", { defaultValue: "Online" });
    case "offline":
      return t("mapView.status.offline", { defaultValue: "Offline" });
    default:
      return t("mapView.status.partial", { defaultValue: "Partially online" });
  }
}

function getUnmappedRegionLabel(t: TranslateFn, region: string) {
  const normalizedRegion = region.trim();
  return normalizedRegion || t("mapView.regionUnknown", { defaultValue: "Not set" });
}

function getRegionStatusBadgeClass(status: "online" | "offline" | "partial") {
  switch (status) {
    case "online":
      return "bg-emerald-500/12 text-emerald-700 dark:bg-emerald-500/18 dark:text-emerald-300";
    case "offline":
      return "bg-rose-500/12 text-rose-700 dark:bg-rose-500/18 dark:text-rose-300";
    default:
      return "bg-amber-500/14 text-amber-700 dark:bg-amber-500/18 dark:text-amber-300";
  }
}

export function NodeMapView({
  nodes,
  liveData,
  mapOnly = false,
}: NodeMapViewProps) {
  const { t } = useTranslation();
  const summary = useMemo(() => buildMapViewSummary(nodes, liveData), [nodes, liveData]);
  const [hoveredRegion, setHoveredRegion] = useState<HoveredRegion | null>(null);
  const [hoveredServerPin, setHoveredServerPin] = useState<HoveredServerPin | null>(null);
  const [mapTransform, setMapTransform] = useState<MapTransform>({ scale: 1, x: 0, y: 0 });
  const dragStateRef = useRef<{ pointerId: number; clientX: number; clientY: number } | null>(null);
  const mapSurfaceRef = useRef<HTMLDivElement | null>(null);
  const hoverCardRef = useRef<HTMLDivElement | null>(null);
  const hoverFrameRef = useRef<number | null>(null);
  const pendingHoverPositionRef = useRef<Omit<HoveredRegion, "regionKey"> | null>(null);
  const hoverRegion =
    summary.regions.find((region) => region.key === hoveredRegion?.regionKey) ?? null;

  const activeRegionsByMapName = useMemo(
    () => new Map(summary.regions.map((region) => [region.mapName, region])),
    [summary.regions],
  );

  const projectedMap = useMemo(() => {
    const countriesGeo = feature(
      worldCountries50m as never,
      (worldCountries50m as unknown as { objects: { countries: never } }).objects.countries,
    ) as unknown as { features: Array<{ id?: string; properties?: { name?: string } }> };

    const projection = geoNaturalEarth1().fitExtent(
      [
        [MAP_HORIZONTAL_PADDING, MAP_TOP_PADDING],
        [SVG_WIDTH - MAP_HORIZONTAL_PADDING, SVG_HEIGHT - MAP_BOTTOM_INSET],
      ],
      countriesGeo as never,
    );

    const pathGenerator = geoPath(projection);
    const spherePath = pathGenerator({ type: "Sphere" }) ?? "";
    const graticulePath = pathGenerator(geoGraticule10()) ?? "";

    const countries = countriesGeo.features
      .map((country) => {
        const name = country.properties?.name ?? String(country.id ?? "unknown");
        const pathData = pathGenerator(country as never) ?? "";
        const activeRegion = activeRegionsByMapName.get(name) ?? null;
        const bounds = pathGenerator.bounds(country as never);
        const width = bounds[1][0] - bounds[0][0];
        const height = bounds[1][1] - bounds[0][1];
        const area = pathGenerator.area(country as never);
        const [markerX, markerY] = pathGenerator.centroid(country as never);
        const shouldShowMarker =
          Boolean(activeRegion) &&
          Number.isFinite(markerX) &&
          Number.isFinite(markerY) &&
          (area < SMALL_REGION_MARKER_AREA_THRESHOLD ||
            Math.max(width, height) < SMALL_REGION_MARKER_SIZE_THRESHOLD);

        return {
          name,
          pathData,
          activeRegion,
          marker:
            shouldShowMarker
              ? {
                  x: markerX,
                  y: markerY,
                }
              : null,
        };
      })
      .filter((country) => country.pathData);

    const regionByKey = new Map(summary.regions.map((region) => [region.key, region]));
    const onlineSet = new Set(liveData?.online ?? []);
    const cityStats = new Map<string, { total: number; online: number; offline: number }>();
    const basePins: Omit<ServerPin, "x" | "y" | "cityTotal" | "cityOnline" | "cityOffline">[] = [];

    for (const node of nodes) {
      const flagCode = (
        node.country_code ||
        node.countryCode ||
        summary.regions.find((region) => region.nodes.some((item) => item.uuid === node.uuid))?.flagCode ||
        ""
      ).toUpperCase();
      const region = regionByKey.get(flagCode);
      const coord = region ? getNodeLonLat(node, region.flagCode) : null;
      const projected = coord ? projection(coord) : null;

      if (!region || !projected || !Number.isFinite(projected[0]) || !Number.isFinite(projected[1])) {
        continue;
      }

      const city = getNodeCity(node, region.flagCode);
      const online = onlineSet.has(node.uuid);
      const cityKey = `${region.key}|${city}`;
      const stats = cityStats.get(cityKey) ?? { total: 0, online: 0, offline: 0 };
      stats.total += 1;
      if (online) {
        stats.online += 1;
      } else {
        stats.offline += 1;
      }
      cityStats.set(cityKey, stats);

      basePins.push({
        key: node.uuid,
        node,
        region,
        city,
        online,
      });
    }

    const cityIndex = new Map<string, number>();
    const serverPins = basePins.map((pin) => {
      const cityKey = `${pin.region.key}|${pin.city}`;
      const stats = cityStats.get(cityKey) ?? { total: 1, online: pin.online ? 1 : 0, offline: pin.online ? 0 : 1 };
      const index = cityIndex.get(cityKey) ?? 0;
      cityIndex.set(cityKey, index + 1);
      const coord = getNodeLonLat(pin.node, pin.region.flagCode);
      const projected = coord ? projection(coord) : [0, 0];
      let x = projected?.[0] ?? 0;
      let y = projected?.[1] ?? 0;

      if (stats.total > 1) {
        const angle = (Math.PI * 2 * index) / stats.total;
        const radius = Math.min(18, 5 + stats.total * 1.6);
        x += Math.cos(angle) * radius;
        y += Math.sin(angle) * radius;
      }

      return {
        ...pin,
        x,
        y,
        cityTotal: stats.total,
        cityOnline: stats.online,
        cityOffline: stats.offline,
      };
    });

    return {
      spherePath,
      graticulePath,
      countries,
      serverPins,
    };
  }, [activeRegionsByMapName, liveData?.online, nodes, summary.regions]);
  const hoverServerPin = hoveredServerPin
    ? projectedMap.serverPins.find((pin) => pin.key === hoveredServerPin.pinKey) ?? null
    : null;
  const hoverPosition = hoveredServerPin
    ? pendingHoverPositionRef.current ?? hoveredServerPin
    : hoveredRegion
      ? pendingHoverPositionRef.current ?? hoveredRegion
      : null;

  const getHoverPosition = useCallback((event: PointerEvent<SVGElement>) => {
    const surfaceRect = mapSurfaceRef.current?.getBoundingClientRect();
    const boundsWidth = surfaceRect?.width ?? window.innerWidth;
    const boundsHeight = surfaceRect?.height ?? window.innerHeight;
    const x = surfaceRect ? event.clientX - surfaceRect.left : event.clientX;
    const y = surfaceRect ? event.clientY - surfaceRect.top : event.clientY;
    const hoverCard = hoverCardRef.current;
    const cardWidth =
      hoverCard?.offsetWidth ??
      Math.min(HOVER_CARD_MAX_WIDTH, Math.max(0, boundsWidth - HOVER_CARD_EDGE_PADDING * 2));
    const cardHeight = hoverCard?.offsetHeight ?? HOVER_CARD_FALLBACK_HEIGHT;
    const spaceRight = boundsWidth - x - HOVER_CARD_GAP;
    const spaceLeft = x - HOVER_CARD_GAP;
    const spaceBelow = boundsHeight - y - HOVER_CARD_GAP;
    const spaceAbove = y - HOVER_CARD_GAP;

    return {
      x,
      y,
      horizontal: spaceRight >= cardWidth || spaceRight >= spaceLeft ? "right" : "left",
      vertical: spaceBelow >= cardHeight || spaceBelow >= spaceAbove ? "below" : "above",
    } satisfies Omit<HoveredRegion, "regionKey">;
  }, []);

  const applyHoverPosition = useCallback((position: Omit<HoveredRegion, "regionKey">) => {
    const hoverCard = hoverCardRef.current;
    if (!hoverCard) {
      return;
    }

    hoverCard.style.setProperty("--node-map-hover-x", `${position.x}px`);
    hoverCard.style.setProperty("--node-map-hover-y", `${position.y}px`);
    hoverCard.dataset.horizontal = position.horizontal;
    hoverCard.dataset.vertical = position.vertical;
  }, []);

  const queueHoverPosition = useCallback(
    (position: Omit<HoveredRegion, "regionKey">) => {
      pendingHoverPositionRef.current = position;

      if (hoverFrameRef.current !== null) {
        return;
      }

      hoverFrameRef.current = window.requestAnimationFrame(() => {
        hoverFrameRef.current = null;
        const nextPosition = pendingHoverPositionRef.current;

        if (nextPosition) {
          applyHoverPosition(nextPosition);
        }
      });
    },
    [applyHoverPosition],
  );

  const updateHoveredRegion = useCallback(
    (event: PointerEvent<SVGElement>, region: MapRegionSummary) => {
      const position = getHoverPosition(event);

      setHoveredServerPin(null);
      setHoveredRegion({
        regionKey: region.key,
        ...position,
      });
      queueHoverPosition(position);
    },
    [getHoverPosition, queueHoverPosition],
  );

  const updateHoveredServerPin = useCallback(
    (event: PointerEvent<SVGElement>, pin: ServerPin) => {
      const position = getHoverPosition(event);

      setHoveredRegion(null);
      setHoveredServerPin({
        pinKey: pin.key,
        ...position,
      });
      queueHoverPosition(position);
    },
    [getHoverPosition, queueHoverPosition],
  );

  const updateHoverPosition = useCallback(
    (event: PointerEvent<SVGElement>) => {
      queueHoverPosition(getHoverPosition(event));
    },
    [getHoverPosition, queueHoverPosition],
  );

  const clearHoveredRegion = useCallback(() => {
    setHoveredRegion(null);
    setHoveredServerPin(null);
    pendingHoverPositionRef.current = null;

    if (hoverFrameRef.current !== null) {
      window.cancelAnimationFrame(hoverFrameRef.current);
      hoverFrameRef.current = null;
    }
  }, []);

  const clampMapTransform = useCallback((transform: MapTransform) => {
    const scale = clamp(transform.scale, MAP_ZOOM_MIN, MAP_ZOOM_MAX);
    if (scale <= MAP_ZOOM_MIN) {
      return { scale: MAP_ZOOM_MIN, x: 0, y: 0 };
    }

    const maxX = SVG_WIDTH * (scale - 1);
    const maxY = SVG_HEIGHT * (scale - 1);

    return {
      scale,
      x: clamp(transform.x, -maxX, 0),
      y: clamp(transform.y, -maxY, 0),
    };
  }, []);

  const handleMapWheel = useCallback(
    (event: WheelEvent<SVGSVGElement>) => {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      const pointX = ((event.clientX - rect.left) / rect.width) * SVG_WIDTH;
      const pointY = ((event.clientY - rect.top) / rect.height) * SVG_HEIGHT;

      setMapTransform((current) => {
        const nextScale = clamp(
          current.scale * (event.deltaY < 0 ? 1.18 : 0.85),
          MAP_ZOOM_MIN,
          MAP_ZOOM_MAX,
        );
        if (nextScale === current.scale) {
          return current;
        }

        return clampMapTransform({
          scale: nextScale,
          x: pointX - (pointX - current.x) * (nextScale / current.scale),
          y: pointY - (pointY - current.y) * (nextScale / current.scale),
        });
      });
    },
    [clampMapTransform],
  );

  const handleMapPointerDown = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      if (mapTransform.scale <= MAP_ZOOM_MIN) {
        return;
      }

      dragStateRef.current = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [mapTransform.scale],
  );

  const handleMapPointerMove = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      const dragState = dragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }

      const rect = event.currentTarget.getBoundingClientRect();
      const deltaX = ((event.clientX - dragState.clientX) / rect.width) * SVG_WIDTH;
      const deltaY = ((event.clientY - dragState.clientY) / rect.height) * SVG_HEIGHT;
      dragState.clientX = event.clientX;
      dragState.clientY = event.clientY;

      setMapTransform((current) =>
        clampMapTransform({
          ...current,
          x: current.x + deltaX,
          y: current.y + deltaY,
        }),
      );
    },
    [clampMapTransform],
  );

  const handleMapPointerEnd = useCallback((event: PointerEvent<SVGSVGElement>) => {
    if (dragStateRef.current?.pointerId === event.pointerId) {
      dragStateRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const resetMapTransform = useCallback(() => {
    setMapTransform({ scale: MAP_ZOOM_MIN, x: 0, y: 0 });
  }, []);

  useEffect(() => {
    return () => {
      if (hoverFrameRef.current !== null) {
        window.cancelAnimationFrame(hoverFrameRef.current);
      }
    };
  }, []);

  if (!summary.totalNodes) {
    return (
      <Card className="overflow-hidden rounded-[28px] border-border/70 bg-card/95 shadow-sm">
        {!mapOnly && (
          <CardHeader>
            <CardTitle>{t("mapView.title", { defaultValue: "Global Distribution" })}</CardTitle>
          </CardHeader>
        )}
        <CardContent>
          <div className="rounded-3xl border border-dashed border-border/70 bg-muted/40 px-6 py-12 text-center text-sm text-muted-foreground">
            {t("nodes.empty", { defaultValue: "No node data" })}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card
      className={
        mapOnly
          ? "node-map-view overflow-visible rounded-none border-0 bg-transparent shadow-none"
          : "node-map-view overflow-hidden rounded-[28px] border-border/70 bg-card/95 shadow-sm"
      }
    >
      {!mapOnly && (
        <CardHeader className="space-y-4 border-b border-border/70 pb-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 rounded-full bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-700 dark:bg-sky-500/14 dark:text-sky-300">
                <MapPinned className="h-3.5 w-3.5" />
                {t("common.map", { defaultValue: "Map" })}
              </div>
              <CardTitle className="text-2xl tracking-tight">
                {t("mapView.title", { defaultValue: "Global Distribution" })}
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                {t("mapView.activeCountries", {
                  count: summary.regions.length,
                  defaultValue: "{{count}} active countries / regions",
                })}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Badge
                variant="secondary"
                className="rounded-full bg-muted px-3 py-1 text-muted-foreground"
              >
                {t("mapView.servers", {
                  count: summary.totalNodes,
                  defaultValue: "{{count}} servers",
                })}
              </Badge>
              <Badge
                variant="secondary"
                className="rounded-full bg-emerald-500/12 px-3 py-1 text-emerald-700 dark:bg-emerald-500/18 dark:text-emerald-300"
              >
                {t("mapView.online", {
                  count: summary.onlineNodes,
                  defaultValue: "{{count}} online",
                })}
              </Badge>
              <Badge
                variant="secondary"
                className="rounded-full bg-rose-500/12 px-3 py-1 text-rose-700 dark:bg-rose-500/18 dark:text-rose-300"
              >
                {t("mapView.offline", {
                  count: summary.offlineNodes,
                  defaultValue: "{{count}} offline",
                })}
              </Badge>
            </div>
          </div>
        </CardHeader>
      )}

      <CardContent className={mapOnly ? "p-0" : "p-5 lg:p-6"}>
        <div className={mapOnly ? "node-map-view__layout node-map-view__layout--map-only" : "node-map-view__layout"}>
          <div ref={mapSurfaceRef} className="node-map-view__surface">
            <svg
              viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
              className={`node-map-view__svg${dragStateRef.current ? " is-dragging" : ""}`}
              role="img"
              aria-label={t("mapView.ariaLabel", { defaultValue: "Global node distribution map" })}
              onWheel={handleMapWheel}
              onPointerDown={handleMapPointerDown}
              onPointerMove={handleMapPointerMove}
              onPointerUp={handleMapPointerEnd}
              onPointerCancel={handleMapPointerEnd}
              onDoubleClick={resetMapTransform}
            >
              <g
                className="node-map-view__viewport"
                transform={`translate(${mapTransform.x} ${mapTransform.y}) scale(${mapTransform.scale})`}
              >
                <path d={projectedMap.spherePath} className="node-map-view__ocean" />
                <path d={projectedMap.graticulePath} className="node-map-view__graticule" />

                <g className="node-map-view__country-layer">
                  {projectedMap.countries.map((country) => {
                    const region = country.activeRegion;
                    const isSelected = hoveredRegion?.regionKey === region?.key;
                    const ariaLabel = region
                      ? t("mapView.countrySummary", {
                          name: region.label,
                          total: region.total,
                          online: region.online,
                          offline: region.offline,
                          defaultValue:
                            "{{name}}: {{total}} nodes, {{online}} online, {{offline}} offline",
                        })
                      : country.name;

                    return (
                      <g key={country.name} className="node-map-view__country-group">
                        <path
                          d={country.pathData}
                          data-country-code={region?.flagCode}
                          data-country-name={country.name}
                          className={`node-map-view__country${region ? ` is-active status-${region.status}` : ""}${isSelected ? " is-selected" : ""}`}
                          aria-label={ariaLabel}
                          onPointerEnter={region ? (event) => updateHoveredRegion(event, region) : undefined}
                          onPointerMove={region ? updateHoverPosition : undefined}
                          onPointerLeave={region ? clearHoveredRegion : undefined}
                        />
                      </g>
                    );
                  })}
                </g>

                <g className="node-map-view__marker-layer">
                  {projectedMap.serverPins.map((pin) => {
                    const isSelected = hoveredServerPin?.pinKey === pin.key;
                    const ariaLabel = `${pin.node.name}: ${pin.city}, ${pin.online ? "online" : "offline"}`;

                    return (
                      <g
                        key={pin.key}
                        className={`node-map-view__server-pin status-${pin.online ? "online" : "offline"}${isSelected ? " is-selected" : ""}`}
                        transform={`translate(${pin.x} ${pin.y})`}
                        aria-label={ariaLabel}
                        onPointerEnter={(event) => updateHoveredServerPin(event, pin)}
                        onPointerMove={updateHoverPosition}
                        onPointerLeave={clearHoveredRegion}
                      >
                        <path
                          className="node-map-view__server-pin-shape"
                          d="M0 -18a7 7 0 0 0-7 7C-7 -5 0 6 0 6S7 -5 7 -11a7 7 0 0 0-7-7Z"
                        />
                        <circle className="node-map-view__server-pin-dot" cy="-11" r="2.2" />
                      </g>
                    );
                  })}
                </g>
              </g>
            </svg>

            <div className="node-map-view__legend node-map-view__legend--inset">
              <div className="node-map-view__legend-card node-map-view__legend-card--status">
                <div className="node-map-view__legend-items node-map-view__legend-items--stacked">
                  <span className="node-map-view__legend-item">
                    <span className="node-map-view__legend-dot status-online" />
                    {t("mapView.legend.online", { defaultValue: "服务器在线" })}
                  </span>
                  <span className="node-map-view__legend-item">
                    <span className="node-map-view__legend-dot status-offline" />
                    {t("mapView.legend.offline", { defaultValue: "服务器离线" })}
                  </span>
                  <span className="node-map-view__legend-item">
                    <span className="node-map-view__legend-dot status-pin" />
                    {t("mapView.legend.pin", { defaultValue: "服务器所在城市" })}
                  </span>
                </div>
              </div>

              {summary.unmappedNodes.length > 0 && (
                <div className="node-map-view__legend-card node-map-view__legend-card--stacked">
                  <div className="node-map-view__legend-unmapped-header">
                    <span className="text-xs font-semibold text-foreground">
                      {t("mapView.unmappedRegions", { defaultValue: "Unmapped Regions" })}
                    </span>
                    <Badge
                      variant="secondary"
                      className="rounded-full bg-amber-500/12 px-2.5 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/18 dark:text-amber-300"
                    >
                      {t("mapView.unmappedCount", {
                        count: summary.unmappedNodes.length,
                        defaultValue: "Total {{count}} items",
                      })}
                    </Badge>
                  </div>
                  <div className="node-map-view__legend-unmapped-list">
                    {summary.unmappedNodes.map((node) => (
                      <div key={`${node.uuid}-unmapped`} className="node-map-view__legend-unmapped-item">
                        <span className="node-map-view__legend-unmapped-region">
                          {getUnmappedRegionLabel(t, node.region)}
                        </span>
                        <span className="node-map-view__legend-unmapped-node">{node.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {(hoverRegion || hoverServerPin) && hoverPosition && (
              <div
                ref={hoverCardRef}
                className="node-map-view__hover-card"
                data-horizontal={hoverPosition.horizontal}
                data-vertical={hoverPosition.vertical}
                style={{
                  "--node-map-hover-x": `${hoverPosition.x}px`,
                  "--node-map-hover-y": `${hoverPosition.y}px`,
                } as CSSProperties}
              >
                {hoverServerPin ? (
                  <div className="node-map-view__detail-header node-map-view__hover-header">
                    <div className="node-map-view__detail-heading">
                      <span className="node-map-view__detail-flag" aria-hidden="true">
                        <Flag flag={hoverServerPin.region.emoji} />
                      </span>
                      <div className="min-w-0 space-y-1">
                        <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                          {hoverServerPin.region.flagCode}
                        </div>
                        <h3 className="truncate text-lg font-semibold tracking-tight text-foreground">
                          {hoverServerPin.region.label}
                        </h3>
                        <div className="node-map-view__hover-count-line">
                          <span className="node-map-view__hover-count-total">
                            {hoverServerPin.node.name}
                          </span>
                          <span className="text-muted-foreground">
                            {hoverServerPin.city}
                          </span>
                        </div>
                        <div className="node-map-view__hover-count-line">
                          <span className="node-map-view__hover-count-total">
                            {hoverServerPin.cityTotal}
                            <span>{t("mapView.stats.nodes", { defaultValue: "Nodes" })}</span>
                          </span>
                          <span className="node-map-view__hover-status-counts">
                            <span className="node-map-view__hover-count node-map-view__hover-count--online">
                              {hoverServerPin.cityOnline} {t("nodeCard.online", { defaultValue: "Online" })}
                            </span>
                            <span className="node-map-view__hover-count node-map-view__hover-count--offline">
                              {hoverServerPin.cityOffline} {t("nodeCard.offline", { defaultValue: "Offline" })}
                            </span>
                          </span>
                        </div>
                      </div>
                    </div>

                    <Badge
                      variant="secondary"
                      className={`shrink-0 whitespace-nowrap rounded-full ${getRegionStatusBadgeClass(hoverServerPin.online ? "online" : "offline")}`}
                    >
                      {hoverServerPin.online
                        ? t("nodeCard.online", { defaultValue: "Online" })
                        : t("nodeCard.offline", { defaultValue: "Offline" })}
                    </Badge>
                  </div>
                ) : hoverRegion ? (
                  <div className="node-map-view__detail-header node-map-view__hover-header">
                  <div className="node-map-view__detail-heading">
                    <span className="node-map-view__detail-flag" aria-hidden="true">
                      <Flag flag={hoverRegion.emoji} />
                    </span>
                    <div className="min-w-0 space-y-1">
                      <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                        {hoverRegion.flagCode}
                      </div>
                      <h3 className="truncate text-lg font-semibold tracking-tight text-foreground">
                        {hoverRegion.label}
                      </h3>
                      <div className="node-map-view__hover-count-line">
                        <span className="node-map-view__hover-count-total">
                          {hoverRegion.total}
                          <span>{t("mapView.stats.nodes", { defaultValue: "Nodes" })}</span>
                        </span>
                        <span className="node-map-view__hover-status-counts">
                          <span className="node-map-view__hover-count node-map-view__hover-count--online">
                            {hoverRegion.online} {t("nodeCard.online", { defaultValue: "Online" })}
                          </span>
                          <span className="node-map-view__hover-count node-map-view__hover-count--offline">
                            {hoverRegion.offline} {t("nodeCard.offline", { defaultValue: "Offline" })}
                          </span>
                        </span>
                      </div>
                    </div>
                  </div>

                  <Badge
                    variant="secondary"
                    className={`shrink-0 whitespace-nowrap rounded-full ${getRegionStatusBadgeClass(hoverRegion.status)}`}
                  >
                    {getStatusText(t, hoverRegion.status)}
                  </Badge>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
