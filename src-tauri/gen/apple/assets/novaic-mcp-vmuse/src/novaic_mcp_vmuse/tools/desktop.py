"""
Desktop Tools - Mouse, Keyboard, Screenshot
Uses xdotool for input and scrot/import for screenshots

New Design (v2):
- screenshot: Pure viewing (area, grid)
- mouse: Two-phase operation (aim → execute)
  - aim: Returns aim_id + screenshot + recommendation
  - execute: Uses aim_id, no direct coordinates
"""

import subprocess
import base64
import tempfile
import os
import time
import secrets
from typing import Dict, Any, Optional, List, Literal, Union
from io import BytesIO

try:
    from PIL import Image, ImageDraw, ImageFont
    HAS_PIL = True
except ImportError:
    HAS_PIL = False


class AimCache:
    """Cache for aim positions with TTL"""
    
    def __init__(self, ttl_seconds: int = 600):  # 10 minutes
        self._cache: Dict[str, Dict[str, Any]] = {}
        self._ttl = ttl_seconds
    
    def create(self, x: int, y: int, zoom: float) -> str:
        """Create a new aim_id and store position"""
        aim_id = f"aim_{secrets.token_hex(4)}"
        self._cache[aim_id] = {
            "x": x,
            "y": y,
            "zoom": zoom,
            "created_at": time.time()
        }
        self._cleanup()
        return aim_id
    
    def get(self, aim_id: str) -> Optional[Dict[str, Any]]:
        """Get position for aim_id, returns None if expired or not found"""
        self._cleanup()
        if aim_id not in self._cache:
            return None
        entry = self._cache[aim_id]
        if time.time() - entry["created_at"] > self._ttl:
            del self._cache[aim_id]
            return None
        return entry
    
    def consume(self, aim_id: str) -> Optional[Dict[str, Any]]:
        """Backward-compatible alias of get(); aim_id is reusable."""
        return self.get(aim_id)
    
    def _cleanup(self):
        """Remove expired entries"""
        now = time.time()
        expired = [k for k, v in self._cache.items() if now - v["created_at"] > self._ttl]
        for k in expired:
            del self._cache[k]


# Global aim cache instance (10 minutes TTL)
_aim_cache = AimCache(ttl_seconds=600)

# Mouse state for down/up operations
_mouse_state = {
    "is_down": False,
    "position": None  # {"x": int, "y": int}
}


class DesktopTools:
    """Desktop control tools using xdotool"""
    
    @staticmethod
    async def screenshot(
        region: Optional[Dict[str, int]] = None,
        center: Optional[Dict[str, int]] = None,
        zoom_factor: Optional[float] = None,
        grid_density: Optional[str] = None,
        prev_center: Optional[Dict[str, int]] = None
    ) -> Dict[str, Any]:
        """
        Take a desktop screenshot with optional coordinate grid overlay
        
        Args:
            region: Optional {x, y, width, height} to capture specific area (legacy mode)
            center: Optional {x, y} center point for zoomed screenshot
            zoom_factor: Optional zoom factor (e.g., 2.0 = 2x zoom, 0.5 = 0.5x zoom)
                        When provided with center, captures area centered at center point
            grid_density: Optional grid density - "fine" (100px), "normal" (200px), "coarse" (400px)
                         If None, auto-selects based on screenshot size
            prev_center: Optional {x, y} previous aim point (for showing delta movement arrow)
        """
        try:
            # First, always capture full screen to get dimensions
            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
                temp_path = f.name
            
            # Capture full screen first (with mouse cursor using -p)
            cmd = ["scrot", "-p", "-o", temp_path]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
            
            if result.returncode != 0:
                # Fallback to import
                cmd = ["import", "-window", "root", temp_path]
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
            
            if result.returncode != 0:
                return {"success": False, "error": f"Screenshot failed: {result.stderr}"}
            
            # Read full screen image
            with open(temp_path, "rb") as f:
                fullscreen_bytes = f.read()
            
            # Get full screen dimensions
            identify_result = subprocess.run(
                ["identify", "-format", "%wx%h", temp_path],
                capture_output=True, text=True
            )
            screen_width, screen_height = 0, 0
            if identify_result.returncode == 0:
                w, h = identify_result.stdout.strip().split("x")
                screen_width, screen_height = int(w), int(h)
            
            # Determine capture mode and calculate region
            offset_x = 0
            offset_y = 0
            capture_width = screen_width
            capture_height = screen_height
            needs_padding = False
            padding_left = 0
            padding_top = 0
            padding_right = 0
            padding_bottom = 0
            
            if zoom_factor is not None:
                # New mode: center + zoom_factor
                # If center is None, (-1, -1), or empty, use screen center
                if center is None or (isinstance(center, dict) and center.get('x') == -1 and center.get('y') == -1):
                    center_x = screen_width // 2
                    center_y = screen_height // 2
                else:
                    center_x = center['x']
                    center_y = center['y']
                
                # Calculate desired capture region size based on zoom factor
                # zoom_factor > 1 means zoom in (smaller capture area)
                # zoom_factor < 1 means zoom out (larger capture area, but we'll limit to screen)
                # zoom_factor = 1.0 means capture area equals screen size
                desired_width = int(screen_width / zoom_factor)
                desired_height = int(screen_height / zoom_factor)
                
                # Calculate desired capture region bounds (centered at center point)
                region_x = center_x - desired_width // 2
                region_y = center_y - desired_height // 2
                region_x_end = region_x + desired_width
                region_y_end = region_y + desired_height
                
                # Check if region exceeds screen bounds
                if region_x < 0 or region_y < 0 or region_x_end > screen_width or region_y_end > screen_height:
                    needs_padding = True
                    
                    # Calculate actual capture bounds (clamped to screen)
                    actual_x = max(0, region_x)
                    actual_y = max(0, region_y)
                    actual_x_end = min(screen_width, region_x_end)
                    actual_y_end = min(screen_height, region_y_end)
                    
                    actual_capture_width = actual_x_end - actual_x
                    actual_capture_height = actual_y_end - actual_y
                    
                    # Calculate padding needed to center the image (in pixels)
                    padding_left = max(0, -region_x)
                    padding_top = max(0, -region_y)
                    padding_right = max(0, region_x_end - screen_width)
                    padding_bottom = max(0, region_y_end - screen_height)
                    
                    # Update capture region to actual bounds
                    offset_x = actual_x
                    offset_y = actual_y
                    capture_width = actual_capture_width
                    capture_height = actual_capture_height
                    
                    # Store desired dimensions for later use
                    desired_capture_width = desired_width
                    desired_capture_height = desired_height
                else:
                    # Region is within screen bounds
                    offset_x = region_x
                    offset_y = region_y
                    capture_width = desired_width
                    capture_height = desired_height
                    # Store desired dimensions (same as capture dimensions when no padding needed)
                    desired_capture_width = desired_width
                    desired_capture_height = desired_height
                    
            elif region:
                # Legacy mode: region parameter
                offset_x = region['x']
                offset_y = region['y']
                capture_width = region['width']
                capture_height = region['height']
            
            # If we need to capture a specific region (not full screen), crop it
            # Skip cropping only if zoom_factor=1.0 AND center is screen center AND no padding needed
            # Otherwise, we need to crop (either because zoom_factor != 1.0, or center != screen center)
            if zoom_factor is not None or region:
                # Check if we need to crop (not full screen, or center is not screen center)
                if zoom_factor == 1.0:
                    # For zoom_factor=1.0, check if center is at screen center
                    if center is None or (isinstance(center, dict) and center.get('x') == -1 and center.get('y') == -1):
                        # Center is screen center, no cropping needed (full screen)
                        pass
                    else:
                        # Center is specified and not screen center, need cropping
                        # Always crop the actual capture region, even if padding is needed
                        # (padding will be added in PIL processing)
                        cmd = [
                            "import", "-window", "root",
                            "-crop", f"{capture_width}x{capture_height}+{offset_x}+{offset_y}",
                            temp_path
                        ]
                        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
                        if result.returncode != 0:
                            return {"success": False, "error": f"Region capture failed: {result.stderr}"}
                else:
                    # zoom_factor != 1.0, always need cropping
                    # Always crop the actual capture region, even if padding is needed
                    cmd = [
                        "import", "-window", "root",
                        "-crop", f"{capture_width}x{capture_height}+{offset_x}+{offset_y}",
                        temp_path
                    ]
                    result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
                    if result.returncode != 0:
                        return {"success": False, "error": f"Region capture failed: {result.stderr}"}
            elif region:
                # Legacy region mode
                # Always crop the actual capture region, even if padding is needed
                cmd = [
                    "import", "-window", "root",
                    "-crop", f"{capture_width}x{capture_height}+{offset_x}+{offset_y}",
                    temp_path
                ]
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
                if result.returncode != 0:
                    return {"success": False, "error": f"Region capture failed: {result.stderr}"}
            
            # Read image (either full screen or cropped)
            with open(temp_path, "rb") as f:
                screenshot_bytes = f.read()
            original_size = len(screenshot_bytes)
            
            # Get dimensions of captured image
            identify_result = subprocess.run(
                ["identify", "-format", "%wx%h", temp_path],
                capture_output=True, text=True
            )
            width, height = 0, 0
            if identify_result.returncode == 0:
                w, h = identify_result.stdout.strip().split("x")
                width, height = int(w), int(h)
            
            # Target resolution for consistent grid size
            TARGET_WIDTH = 1920
            TARGET_HEIGHT = 1080
            GRID_CELL_SIZE = 100  # Fixed grid cell size in pixels (after resize) - 每个网格格子固定100x100像素
            
            print(f"[DesktopTools] HAS_PIL={HAS_PIL}, width={width}, height={height}, offset=({offset_x}, {offset_y})")
            
            # Variables for resize tracking
            original_width = width
            original_height = height
            scale = 1.0
            
            # Check if this is a plain fullscreen screenshot (no zoom, no region)
            # In this case, return the raw screenshot without any grid/labels/processing
            is_plain_fullscreen = zoom_factor is None and region is None
            
            if is_plain_fullscreen:
                # Plain fullscreen: return raw screenshot without any processing
                print(f"[DesktopTools] Plain fullscreen mode - returning raw screenshot")
                os.unlink(temp_path)
                
                return {
                    "success": True,
                    "screenshot": base64.b64encode(screenshot_bytes).decode('utf-8'),
                    "width": width,
                    "height": height,
                    "screen_size": {"width": screen_width, "height": screen_height},
                    "hint": f"""FULL SCREEN ({screen_width}x{screen_height}).

⚠️ TO CLICK:
1. Estimate target coordinates (X, Y) from the image
2. mouse(action='aim', x=X, y=Y) to aim and verify
3. Follow the recommendation in aim result"""
                }
            
            if HAS_PIL and width > 0 and height > 0:
                try:
                    # Open image
                    img = Image.open(BytesIO(screenshot_bytes))
                    original_width, original_height = img.size
                    print(f"[DesktopTools] Original image mode: {img.mode}, size: {original_width}x{original_height}")
                    
                    # Handle padding if needed (for center+zoom mode when region exceeds screen bounds)
                    if needs_padding and padding_left + padding_top + padding_right + padding_bottom > 0:
                        # Create new image with desired size (white background)
                        padded_img = Image.new('RGB', (desired_capture_width, desired_capture_height), (255, 255, 255))
                        # Paste captured image at the correct position (accounting for padding)
                        padded_img.paste(img, (padding_left, padding_top))
                        img = padded_img
                        original_width = desired_capture_width
                        original_height = desired_capture_height
                        print(f"[DesktopTools] Added padding: left={padding_left}, top={padding_top}, right={padding_right}, bottom={padding_bottom}")
                        print(f"[DesktopTools] Desired region size: {desired_capture_width}x{desired_capture_height}, actual capture: {capture_width}x{capture_height}")
                        print(f"[DesktopTools] Padded image size: {original_width}x{original_height}")
                        
                        # Update offset_x and offset_y to reflect the desired region start (not actual capture start)
                        # This ensures grid coordinates start from the correct system coordinates
                        # center_x and center_y are already calculated above in the zoom_factor block
                        offset_x = center_x - desired_capture_width // 2
                        offset_y = center_y - desired_capture_height // 2
                        print(f"[DesktopTools] Updated offset for grid: offset_x={offset_x}, offset_y={offset_y} (desired region start)")
                    
                    # Calculate scaling factors - maintain aspect ratio
                    scale_x = TARGET_WIDTH / original_width
                    scale_y = TARGET_HEIGHT / original_height
                    scale = min(scale_x, scale_y)  # Use uniform scaling
                    
                    # Resize image to target resolution (maintaining aspect ratio)
                    new_width = int(original_width * scale)
                    new_height = int(original_height * scale)
                    img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
                    print(f"[DesktopTools] Resized to: {new_width}x{new_height} (scale: {scale:.3f})")
                    
                    # Update width/height for grid drawing (use resized dimensions)
                    width = new_width
                    height = new_height
                    
                    # Convert to RGBA if needed
                    if img.mode != 'RGBA':
                        img = img.convert('RGBA')
                    
                    # Calculate padding and new dimensions for coordinate labels
                    # Padding: left, top, right, bottom (for coordinates and labels)
                    # Doubled from original (30->60, 60->120)
                    coord_label_height = 60  # Space for coordinate labels on top/bottom
                    coord_label_width = 120  # Space for coordinate labels on left/right
                    label_padding_top = coord_label_height  # No instruction text anymore
                    label_padding_bottom = coord_label_height
                    label_padding_left = coord_label_width
                    label_padding_right = coord_label_width
                    
                    new_width = width + label_padding_left + label_padding_right
                    new_height = height + label_padding_top + label_padding_bottom
                    
                    # Create new image with padding for labels (white background)
                    new_img = Image.new('RGB', (new_width, new_height), (255, 255, 255))
                    # Paste original image in the center
                    new_img.paste(img, (label_padding_left, label_padding_top))
                    
                    # Create drawing context for the new image
                    draw = ImageDraw.Draw(new_img)
                    print(f"[DesktopTools] Created padded image, size: {new_width}x{new_height}")
                    
                    # Grid spacing - use INTEGER values in ORIGINAL coordinate system
                    # This ensures coordinate labels are always nice round numbers
                    # The spacing is defined in original (system) coordinates, not resized pixels
                    
                    # AimClick Adaptive Grid System (Dynamic Subdivision):
                    # - Always show primary (labeled) + secondary (unlabeled) grid lines
                    # - When zoomed in and spacing > threshold, subdivide:
                    #   - Secondary lines become primary (get labels)
                    #   - New secondary lines inserted at midpoints
                    # - This creates infinite adaptive density
                    
                    # Threshold for subdivision - when grid lines are too far apart, subdivide
                    # ~12cm ≈ 400 pixels on screen (increased 4x from 100)
                    SUBDIVISION_THRESHOLD = 400  # pixels after resize
                    
                    # Start with base spacing of 200px (non-zoom mode)
                    # Subdivide by 2 each time until spacing is reasonable
                    base_spacing = 200
                    primary_grid_spacing = base_spacing
                    
                    # Calculate how many times we need to subdivide
                    # Each subdivision halves the spacing
                    subdivisions = 0
                    while True:
                        spacing_in_pixels = int(primary_grid_spacing * scale)
                        if spacing_in_pixels <= SUBDIVISION_THRESHOLD:
                            break
                        # Subdivide: current primary spacing becomes secondary
                        primary_grid_spacing = primary_grid_spacing // 2
                        subdivisions += 1
                        # Safety check: don't go below 10px
                        if primary_grid_spacing < 10:
                            primary_grid_spacing = 10
                            break
                    
                    # Secondary spacing is always half of primary
                    secondary_grid_spacing = primary_grid_spacing // 2
                    if secondary_grid_spacing < 5:
                        secondary_grid_spacing = 0  # Too small, skip secondary lines
                    
                    # Calculate actual pixel spacing
                    primary_grid_spacing_pixels = int(primary_grid_spacing * scale)
                    secondary_grid_spacing_pixels = int(secondary_grid_spacing * scale) if secondary_grid_spacing > 0 else 0
                    
                    # Font size for grid labels
                    font_size = 32  # Reduced from 48 (48 * 2/3)
                    instruction_font_size = 14
                    
                    # For backward compatibility
                    original_grid_spacing = primary_grid_spacing
                    grid_spacing = primary_grid_spacing_pixels
                    
                    # Always need secondary lines (unless too small)
                    need_secondary_lines = secondary_grid_spacing > 0
                    
                    print(f"[DesktopTools] Adaptive Grid: primary={primary_grid_spacing}px ({primary_grid_spacing_pixels}px), secondary={secondary_grid_spacing}px ({secondary_grid_spacing_pixels}px), subdivisions={subdivisions}")
                    
                    # Try to load fonts, fallback to default if not available
                    # Use bold font for grid labels for better visibility
                    try:
                        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", font_size)
                        instruction_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", instruction_font_size)
                    except:
                        try:
                            font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", font_size)
                            instruction_font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", instruction_font_size)
                        except:
                            try:
                                # Try another common Linux font
                                font = ImageFont.truetype("/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf", font_size)
                                instruction_font = ImageFont.truetype("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", instruction_font_size)
                            except:
                                font = ImageFont.load_default()
                                instruction_font = ImageFont.load_default()
                    
                    # Draw grid lines and coordinates
                    # Use red lines for visibility
                    primary_line_color = (255, 0, 0, 255)  # Red for primary lines (with labels)
                    secondary_line_color = (255, 100, 100, 200)  # Lighter red for secondary lines (no labels)
                    text_bg_color = (255, 255, 255, 255)  # White background for text
                    text_color = (0, 0, 0, 255)  # Black text for high contrast
                    
                    # Line widths
                    primary_line_width = 1
                    secondary_line_width = 1
                    
                    # Draw border around the screenshot area
                    border_color = (200, 200, 200, 255)  # Gray border
                    draw.rectangle(
                        [label_padding_left - 1, label_padding_top - 1, label_padding_left + width, label_padding_top + height],
                        outline=border_color,
                        width=2
                    )
                    
                    # AIM MODE: Draw crosshair coordinate axes with delta scale
                    # Normal mode: Draw traditional grid
                    is_aim_mode = zoom_factor is not None and center is not None
                    
                    if is_aim_mode:
                        # ========== AIM MODE: Full Grid + Delta Scale on Axes ==========
                        # Draw full grid lines with delta scale labels on X/Y axes
                        
                        crosshair_sys_x = center_x
                        crosshair_sys_y = center_y
                        
                        # Convert aim point to pixel position in resized screenshot
                        visible_start_x_system = offset_x
                        visible_start_y_system = offset_y
                        crosshair_pixel_x = int((crosshair_sys_x - visible_start_x_system) * scale)
                        crosshair_pixel_y = int((crosshair_sys_y - visible_start_y_system) * scale)
                        
                        # Add padding offset to get position in final image
                        crosshair_x = label_padding_left + crosshair_pixel_x
                        crosshair_y = label_padding_top + crosshair_pixel_y
                        
                        # Colors
                        axis_color = (255, 0, 255, 255)  # Magenta for main axes
                        grid_color = (255, 0, 255, 100)  # Light magenta for grid lines
                        origin_color = (255, 0, 255, 255)  # Magenta for origin marker
                        
                        # Calculate grid spacing based on zoom level
                        # Aim mode uses 2x denser grid for precise positioning
                        if zoom_factor >= 10:
                            grid_spacing_system = 5   # Ultra fine
                        elif zoom_factor >= 6:
                            grid_spacing_system = 10  # Very fine
                        elif zoom_factor >= 4:
                            grid_spacing_system = 25  # Fine
                        elif zoom_factor >= 2:
                            grid_spacing_system = 50  # Normal
                        else:
                            grid_spacing_system = 100
                        
                        grid_spacing_pixels = int(grid_spacing_system * scale)
                        
                        # Load font for delta labels
                        delta_font_size = 24
                        try:
                            delta_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", delta_font_size)
                        except:
                            try:
                                delta_font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", delta_font_size)
                            except:
                                delta_font = ImageFont.load_default()
                        
                        # ===== Grid lines removed to reduce visual clutter =====
                        # Only keeping coordinate axes and tick marks with labels
                        
                        # ===== Draw main axes (X-axis and Y-axis through crosshair) =====
                        axis_width = 2
                        # X-axis (horizontal through aim point)
                        draw.line(
                            [(label_padding_left, crosshair_y), (label_padding_left + width, crosshair_y)],
                            fill=axis_color,
                            width=axis_width
                        )
                        # Y-axis (vertical through aim point)
                        draw.line(
                            [(crosshair_x, label_padding_top), (crosshair_x, label_padding_top + height)],
                            fill=axis_color,
                            width=axis_width
                        )
                        
                        # ===== Draw delta labels on X-axis =====
                        tick_length = 8
                        # Label every other grid line to avoid clutter
                        label_spacing_system = grid_spacing_system * 2
                        
                        # Left side (negative delta_x)
                        pos_x = crosshair_x - grid_spacing_pixels
                        delta_val = -grid_spacing_system
                        while pos_x >= label_padding_left:
                            # Draw tick mark on X-axis
                            draw.line(
                                [(pos_x, crosshair_y - tick_length), (pos_x, crosshair_y + tick_length)],
                                fill=axis_color,
                                width=2
                            )
                            # Only label every other tick
                            if abs(delta_val) % label_spacing_system == 0:
                                label_text = str(delta_val)
                                bbox = draw.textbbox((0, 0), label_text, font=delta_font)
                                text_width = bbox[2] - bbox[0]
                                text_height = bbox[3] - bbox[1]
                                label_x = pos_x - text_width // 2
                                label_y = crosshair_y + tick_length + 3
                                if label_y + text_height < label_padding_top + height:
                                    draw.rectangle(
                                        [label_x - 2, label_y - 1, label_x + text_width + 2, label_y + text_height + 1],
                                        fill=(255, 255, 255, 230)
                                    )
                                    draw.text((label_x, label_y), label_text, fill=axis_color, font=delta_font)
                            pos_x -= grid_spacing_pixels
                            delta_val -= grid_spacing_system
                        
                        # Right side (positive delta_x)
                        pos_x = crosshair_x + grid_spacing_pixels
                        delta_val = grid_spacing_system
                        while pos_x <= label_padding_left + width:
                            # Draw tick mark on X-axis
                            draw.line(
                                [(pos_x, crosshair_y - tick_length), (pos_x, crosshair_y + tick_length)],
                                fill=axis_color,
                                width=2
                            )
                            # Only label every other tick
                            if delta_val % label_spacing_system == 0:
                                label_text = f"+{delta_val}"
                                bbox = draw.textbbox((0, 0), label_text, font=delta_font)
                                text_width = bbox[2] - bbox[0]
                                text_height = bbox[3] - bbox[1]
                                label_x = pos_x - text_width // 2
                                label_y = crosshair_y + tick_length + 3
                                if label_y + text_height < label_padding_top + height:
                                    draw.rectangle(
                                        [label_x - 2, label_y - 1, label_x + text_width + 2, label_y + text_height + 1],
                                        fill=(255, 255, 255, 230)
                                    )
                                    draw.text((label_x, label_y), label_text, fill=axis_color, font=delta_font)
                            pos_x += grid_spacing_pixels
                            delta_val += grid_spacing_system
                        
                        # ===== Draw delta labels on Y-axis =====
                        # Above crosshair (negative delta_y)
                        pos_y = crosshair_y - grid_spacing_pixels
                        delta_val = -grid_spacing_system
                        while pos_y >= label_padding_top:
                            # Draw tick mark on Y-axis
                            draw.line(
                                [(crosshair_x - tick_length, pos_y), (crosshair_x + tick_length, pos_y)],
                                fill=axis_color,
                                width=2
                            )
                            # Only label every other tick
                            if abs(delta_val) % label_spacing_system == 0:
                                label_text = str(delta_val)
                                bbox = draw.textbbox((0, 0), label_text, font=delta_font)
                                text_width = bbox[2] - bbox[0]
                                text_height = bbox[3] - bbox[1]
                                label_x = crosshair_x + tick_length + 3
                                label_y = pos_y - text_height // 2
                                if label_x + text_width < label_padding_left + width:
                                    draw.rectangle(
                                        [label_x - 2, label_y - 1, label_x + text_width + 2, label_y + text_height + 1],
                                        fill=(255, 255, 255, 230)
                                    )
                                    draw.text((label_x, label_y), label_text, fill=axis_color, font=delta_font)
                            pos_y -= grid_spacing_pixels
                            delta_val -= grid_spacing_system
                        
                        # Below crosshair (positive delta_y)
                        pos_y = crosshair_y + grid_spacing_pixels
                        delta_val = grid_spacing_system
                        while pos_y <= label_padding_top + height:
                            # Draw tick mark on Y-axis
                            draw.line(
                                [(crosshair_x - tick_length, pos_y), (crosshair_x + tick_length, pos_y)],
                                fill=axis_color,
                                width=2
                            )
                            # Only label every other tick
                            if delta_val % label_spacing_system == 0:
                                label_text = f"+{delta_val}"
                                bbox = draw.textbbox((0, 0), label_text, font=delta_font)
                                text_width = bbox[2] - bbox[0]
                                text_height = bbox[3] - bbox[1]
                                label_x = crosshair_x + tick_length + 3
                                label_y = pos_y - text_height // 2
                                if label_x + text_width < label_padding_left + width:
                                    draw.rectangle(
                                        [label_x - 2, label_y - 1, label_x + text_width + 2, label_y + text_height + 1],
                                        fill=(255, 255, 255, 230)
                                    )
                                    draw.text((label_x, label_y), label_text, fill=axis_color, font=delta_font)
                            pos_y += grid_spacing_pixels
                            delta_val += grid_spacing_system
                        
                        # ===== Draw previous position and movement arrow (if delta adjustment) =====
                        if prev_center is not None:
                            prev_sys_x = prev_center.get("x", 0)
                            prev_sys_y = prev_center.get("y", 0)
                            
                            # Convert prev position to pixel coordinates
                            prev_pixel_x = int((prev_sys_x - visible_start_x_system) * scale)
                            prev_pixel_y = int((prev_sys_y - visible_start_y_system) * scale)
                            prev_x = label_padding_left + prev_pixel_x
                            prev_y = label_padding_top + prev_pixel_y
                            
                            # Only draw if prev position is within visible area
                            if (label_padding_left <= prev_x <= label_padding_left + width and
                                label_padding_top <= prev_y <= label_padding_top + height):
                                
                                # Draw previous position marker (X shape in blue/cyan)
                                prev_color = (0, 180, 255, 255)  # Cyan
                                prev_size = 12
                                prev_width = 3
                                # Draw X
                                draw.line(
                                    [(prev_x - prev_size, prev_y - prev_size), 
                                     (prev_x + prev_size, prev_y + prev_size)],
                                    fill=prev_color, width=prev_width
                                )
                                draw.line(
                                    [(prev_x - prev_size, prev_y + prev_size), 
                                     (prev_x + prev_size, prev_y - prev_size)],
                                    fill=prev_color, width=prev_width
                                )
                                
                                # Draw arrow from prev to current
                                arrow_color = (0, 180, 255, 200)
                                arrow_width = 2
                                
                                # Calculate arrow direction
                                dx = crosshair_x - prev_x
                                dy = crosshair_y - prev_y
                                distance = (dx**2 + dy**2) ** 0.5
                                
                                if distance > 30:  # Only draw arrow if significant movement
                                    # Normalize direction
                                    if distance > 0:
                                        nx, ny = dx / distance, dy / distance
                                    else:
                                        nx, ny = 0, 0
                                    
                                    # Arrow starts from prev marker edge, ends before current marker
                                    start_offset = prev_size + 5
                                    end_offset = 15  # Distance from crosshair center
                                    
                                    arrow_start_x = prev_x + nx * start_offset
                                    arrow_start_y = prev_y + ny * start_offset
                                    arrow_end_x = crosshair_x - nx * end_offset
                                    arrow_end_y = crosshair_y - ny * end_offset
                                    
                                    # Draw main arrow line
                                    draw.line(
                                        [(arrow_start_x, arrow_start_y), (arrow_end_x, arrow_end_y)],
                                        fill=arrow_color, width=arrow_width
                                    )
                                    
                                    # Draw arrowhead
                                    arrow_head_size = 10
                                    # Perpendicular direction
                                    px, py = -ny, nx
                                    # Arrowhead points
                                    head_x1 = arrow_end_x - nx * arrow_head_size + px * arrow_head_size * 0.5
                                    head_y1 = arrow_end_y - ny * arrow_head_size + py * arrow_head_size * 0.5
                                    head_x2 = arrow_end_x - nx * arrow_head_size - px * arrow_head_size * 0.5
                                    head_y2 = arrow_end_y - ny * arrow_head_size - py * arrow_head_size * 0.5
                                    
                                    draw.polygon(
                                        [(arrow_end_x, arrow_end_y), (head_x1, head_y1), (head_x2, head_y2)],
                                        fill=arrow_color
                                    )
                                
                                # Label for previous position
                                prev_label = "prev"
                                try:
                                    small_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 14)
                                except:
                                    small_font = ImageFont.load_default()
                                bbox = draw.textbbox((0, 0), prev_label, font=small_font)
                                text_w = bbox[2] - bbox[0]
                                text_h = bbox[3] - bbox[1]
                                label_px = prev_x - text_w // 2
                                label_py = prev_y + prev_size + 3
                                draw.rectangle(
                                    [label_px - 2, label_py - 1, label_px + text_w + 2, label_py + text_h + 1],
                                    fill=(255, 255, 255, 230)
                                )
                                draw.text((label_px, label_py), prev_label, fill=prev_color, font=small_font)
                                
                                print(f"[DesktopTools] Drew movement arrow from ({prev_sys_x}, {prev_sys_y}) to ({crosshair_sys_x}, {crosshair_sys_y})")
                        
                        # ===== Draw origin marker (double circle at crosshair) =====
                        # Outer ring - more visible
                        outer_radius = 20
                        draw.ellipse(
                            [crosshair_x - outer_radius, crosshair_y - outer_radius,
                             crosshair_x + outer_radius, crosshair_y + outer_radius],
                            outline=origin_color,
                            width=3
                        )
                        # Inner ring
                        inner_radius = 8
                        draw.ellipse(
                            [crosshair_x - inner_radius, crosshair_y - inner_radius,
                             crosshair_x + inner_radius, crosshair_y + inner_radius],
                            outline=origin_color,
                            width=3
                        )
                        # Draw "0" label at origin (offset to avoid overlap)
                        zero_label = "0"
                        bbox = draw.textbbox((0, 0), zero_label, font=delta_font)
                        text_width = bbox[2] - bbox[0]
                        text_height = bbox[3] - bbox[1]
                        # Position in top-left quadrant of crosshair (outside outer ring)
                        zero_x = crosshair_x - outer_radius - text_width - 5
                        zero_y = crosshair_y - outer_radius - text_height - 5
                        draw.rectangle(
                            [zero_x - 2, zero_y - 1, zero_x + text_width + 2, zero_y + text_height + 1],
                            fill=(255, 255, 255, 230)
                        )
                        draw.text((zero_x, zero_y), zero_label, fill=origin_color, font=delta_font)
                        
                        # Show absolute coordinates in corner (for reference)
                        coord_label = f"aim: ({crosshair_sys_x}, {crosshair_sys_y})"
                        coord_font_size = 16
                        try:
                            coord_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", coord_font_size)
                        except:
                            coord_font = ImageFont.load_default()
                        bbox = draw.textbbox((0, 0), coord_label, font=coord_font)
                        text_width = bbox[2] - bbox[0]
                        text_height = bbox[3] - bbox[1]
                        # Top-left corner
                        draw.rectangle(
                            [label_padding_left + 5, label_padding_top + 5,
                             label_padding_left + text_width + 15, label_padding_top + text_height + 15],
                            fill=(255, 255, 255, 230)
                        )
                        draw.text((label_padding_left + 10, label_padding_top + 10), coord_label, fill=(100, 100, 100, 255), font=coord_font)
                        
                        print(f"[DesktopTools] Drew aim grid at ({crosshair_sys_x}, {crosshair_sys_y}), grid spacing: {grid_spacing_system}px")
                        
                    else:
                        # ========== NORMAL MODE: Traditional Grid ==========
                        # Calculate which grid lines to draw based on system coordinates
                        # Since we resized the image, we need to convert system coordinates to resized pixel positions
                        # original_grid_spacing is defined in original (system) coordinates (e.g., 50, 100, 200)
                        # Conversion: pixel_x = (sys_x - offset_x) * scale
                        
                        # Find the first grid line that's >= offset_x (in system coordinates)
                        # Round UP to nearest grid line (ensures integer coordinates)
                        start_x = ((offset_x + original_grid_spacing - 1) // original_grid_spacing) * original_grid_spacing
                        
                        # Calculate the actual system coordinate range for the visible area
                        # When needs_padding, offset_x/offset_y now represent the desired region start
                        visible_start_x_system = offset_x
                        visible_end_x_system = offset_x + original_width
                        pixel_offset_x = 0  # No pixel offset needed, padding is already in the image
                        
                        # Vertical lines - draw system coordinates
                        # Iterate through system coordinates, convert to resized pixels
                        end_x_system = visible_end_x_system
                        
                        # Helper function to draw dashed line
                        def draw_dashed_line(draw, start, end, color, width=1, dash_length=8, gap_length=4):
                            """Draw a dashed line from start to end"""
                            x1, y1 = start
                            x2, y2 = end
                            # Calculate line length and direction
                            dx = x2 - x1
                            dy = y2 - y1
                            length = (dx**2 + dy**2) ** 0.5
                            if length == 0:
                                return
                            # Normalize direction
                            dx, dy = dx / length, dy / length
                            # Draw dashes
                            pos = 0
                            while pos < length:
                                dash_end = min(pos + dash_length, length)
                                draw.line(
                                    [(x1 + dx * pos, y1 + dy * pos), (x1 + dx * dash_end, y1 + dy * dash_end)],
                                    fill=color,
                                    width=width
                                )
                                pos += dash_length + gap_length
                        
                        # First draw secondary lines (if needed) - they go behind primary lines
                        if need_secondary_lines:
                            # Secondary lines at half of primary intervals, but skip positions that are primary lines
                            secondary_start_x = ((offset_x + secondary_grid_spacing - 1) // secondary_grid_spacing) * secondary_grid_spacing
                            for sys_x in range(secondary_start_x, end_x_system + 1, secondary_grid_spacing):
                                # Skip if this is a primary line position (divisible by primary_grid_spacing)
                                if sys_x % primary_grid_spacing == 0:
                                    continue
                                # Calculate pixel position in resized screenshot
                                pixel_x_in_screenshot = int((sys_x - visible_start_x_system) * scale)
                                if 0 <= pixel_x_in_screenshot <= width:
                                    actual_x = label_padding_left + pixel_x_in_screenshot
                                    # Draw secondary vertical line as dashed (no label)
                                    draw_dashed_line(
                                        draw,
                                        (actual_x, label_padding_top),
                                        (actual_x, label_padding_top + height),
                                        secondary_line_color,
                                        secondary_line_width
                                    )
                        
                        # Now draw primary lines with labels
                        for sys_x in range(start_x, end_x_system + 1, original_grid_spacing):
                            # Calculate pixel position in resized screenshot
                            pixel_x_in_screenshot = int((sys_x - visible_start_x_system) * scale)
                            if 0 <= pixel_x_in_screenshot <= width:
                                # Actual x position in new image (with label padding)
                                actual_x = label_padding_left + pixel_x_in_screenshot
                                
                                # Draw primary vertical line through screenshot area
                                draw.line(
                                    [(actual_x, label_padding_top), (actual_x, label_padding_top + height)],
                                    fill=primary_line_color,
                                    width=primary_line_width
                                )
                                
                                # Draw coordinate label at top (outside screenshot, in padding area)
                                coord_text = str(sys_x)
                                bbox = draw.textbbox((0, 0), coord_text, font=font)
                                text_width = bbox[2] - bbox[0]
                                text_height = bbox[3] - bbox[1]
                                
                                # Draw label above screenshot area
                                label_y = label_padding_top - text_height - 5
                                draw.rectangle(
                                    [actual_x - text_width // 2 - 3, label_y - 2, actual_x + text_width // 2 + 3, label_y + text_height + 2],
                                    fill=text_bg_color,
                                    outline=(200, 200, 200, 255),
                                    width=1
                                )
                                draw.text(
                                    (actual_x - text_width // 2, label_y),
                                    coord_text,
                                    fill=text_color,
                                    font=font
                                )
                                
                                # Draw coordinate label at bottom (outside screenshot, in padding area)
                                label_y_bottom = label_padding_top + height + 5
                                draw.rectangle(
                                    [actual_x - text_width // 2 - 3, label_y_bottom - 2, actual_x + text_width // 2 + 3, label_y_bottom + text_height + 2],
                                    fill=text_bg_color,
                                    outline=(200, 200, 200, 255),
                                    width=1
                                )
                                draw.text(
                                    (actual_x - text_width // 2, label_y_bottom),
                                    coord_text,
                                    fill=text_color,
                                    font=font
                                )
                        
                        # Find the first grid line that's >= offset_y (in system coordinates)
                        # Round UP to nearest grid line (ensures integer coordinates)
                        start_y = ((offset_y + original_grid_spacing - 1) // original_grid_spacing) * original_grid_spacing
                        
                        # Calculate the actual system coordinate range for the visible area (Y axis)
                        visible_start_y_system = offset_y
                        visible_end_y_system = offset_y + original_height
                        pixel_offset_y = 0  # No pixel offset needed, padding is already in the image
                        
                        # Horizontal lines - draw system coordinates
                        # Iterate through system coordinates, convert to resized pixels
                        end_y_system = visible_end_y_system
                        
                        # First draw secondary horizontal lines (if needed) - they go behind primary lines
                        if need_secondary_lines:
                            # Secondary lines at half of primary intervals, but skip positions that are primary lines
                            secondary_start_y = ((offset_y + secondary_grid_spacing - 1) // secondary_grid_spacing) * secondary_grid_spacing
                            for sys_y in range(secondary_start_y, end_y_system + 1, secondary_grid_spacing):
                                # Skip if this is a primary line position (divisible by primary_grid_spacing)
                                if sys_y % primary_grid_spacing == 0:
                                    continue
                                # Calculate pixel position in resized screenshot
                                pixel_y_in_screenshot = int((sys_y - visible_start_y_system) * scale)
                                if 0 <= pixel_y_in_screenshot <= height:
                                    actual_y = label_padding_top + pixel_y_in_screenshot
                                    # Draw secondary horizontal line as dashed (no label)
                                    draw_dashed_line(
                                        draw,
                                        (label_padding_left, actual_y),
                                        (label_padding_left + width, actual_y),
                                        secondary_line_color,
                                        secondary_line_width
                                    )
                        
                        # Now draw primary lines with labels
                        for sys_y in range(start_y, end_y_system + 1, original_grid_spacing):
                            # Calculate pixel position in resized screenshot
                            pixel_y_in_screenshot = int((sys_y - visible_start_y_system) * scale)
                            if 0 <= pixel_y_in_screenshot <= height:
                                # Actual y position in new image (with label padding)
                                actual_y = label_padding_top + pixel_y_in_screenshot
                                
                                # Draw primary horizontal line through screenshot area
                                draw.line(
                                    [(label_padding_left, actual_y), (label_padding_left + width, actual_y)],
                                    fill=primary_line_color,
                                    width=primary_line_width
                                )
                                
                                # Draw coordinate label on left (outside screenshot, in padding area)
                                coord_text = str(sys_y)
                                bbox = draw.textbbox((0, 0), coord_text, font=font)
                                text_width = bbox[2] - bbox[0]
                                text_height = bbox[3] - bbox[1]
                                
                                # Draw label to the left of screenshot area
                                label_x = label_padding_left - text_width - 8
                                draw.rectangle(
                                    [label_x - 3, actual_y - text_height // 2 - 2, label_x + text_width + 3, actual_y + text_height // 2 + 2],
                                    fill=text_bg_color,
                                    outline=(200, 200, 200, 255),
                                    width=1
                                )
                                draw.text(
                                    (label_x, actual_y - text_height // 2),
                                    coord_text,
                                    fill=text_color,
                                    font=font
                                )
                                
                                # Draw coordinate label on right (outside screenshot, in padding area)
                                label_x_right = label_padding_left + width + 8
                                draw.rectangle(
                                    [label_x_right - 3, actual_y - text_height // 2 - 2, label_x_right + text_width + 3, actual_y + text_height // 2 + 2],
                                    fill=text_bg_color,
                                    outline=(200, 200, 200, 255),
                                    width=1
                                )
                                draw.text(
                                    (label_x_right, actual_y - text_height // 2),
                                    coord_text,
                                    fill=text_color,
                                    font=font
                                )
                        
                        # Count grid lines drawn
                        num_primary_vertical = len([x for x in range(start_x, end_x_system + 1, original_grid_spacing) if visible_start_x_system <= x <= visible_end_x_system])
                        num_primary_horizontal = len([y for y in range(start_y, end_y_system + 1, original_grid_spacing) if visible_start_y_system <= y <= visible_end_y_system])
                        
                        if need_secondary_lines:
                            secondary_start_x_count = ((offset_x + secondary_grid_spacing - 1) // secondary_grid_spacing) * secondary_grid_spacing
                            secondary_start_y_count = ((offset_y + secondary_grid_spacing - 1) // secondary_grid_spacing) * secondary_grid_spacing
                            num_secondary_vertical = len([x for x in range(secondary_start_x_count, end_x_system + 1, secondary_grid_spacing) if visible_start_x_system <= x <= visible_end_x_system and x % primary_grid_spacing != 0])
                            num_secondary_horizontal = len([y for y in range(secondary_start_y_count, end_y_system + 1, secondary_grid_spacing) if visible_start_y_system <= y <= visible_end_y_system and y % primary_grid_spacing != 0])
                            print(f"[DesktopTools] Adaptive Grid: {num_primary_vertical}+{num_secondary_vertical} vertical, {num_primary_horizontal}+{num_secondary_horizontal} horizontal (primary+secondary)")
                        else:
                            print(f"[DesktopTools] Grid: {num_primary_vertical} vertical, {num_primary_horizontal} horizontal (primary only, spacing: {original_grid_spacing}px)")
                        print(f"[DesktopTools] Padded image size: {new_width}x{new_height} (original: {width}x{height})")
                        if needs_padding:
                            print(f"[DesktopTools] Center mode with padding: center=({center_x}, {center_y}), zoom_factor={zoom_factor}")
                            print(f"[DesktopTools] Capture region: ({offset_x}, {offset_y}) size {capture_width}x{capture_height}")
                    
                    # Use the new image with padding and grid/crosshair
                    img = new_img
                    
                    # Add thumbnail in bottom-right corner unless showing full screen
                    # Only skip thumbnail when the image shows the complete screen (no zoom, no movement, no padding)
                    show_thumbnail = True
                    if zoom_factor is None and region is None:
                        # No zoom_factor and no region means full screen - no thumbnail needed
                        show_thumbnail = False
                    elif zoom_factor == 1.0:
                        # Check if center is screen center and no padding needed (i.e., showing full screen)
                        if (center is None or (isinstance(center, dict) and center.get('x') == -1 and center.get('y') == -1)):
                            # Center is screen center
                            if not needs_padding:
                                # Full screen, no thumbnail needed
                                show_thumbnail = False
                    # For all other cases (zoom_factor != 1.0, or center != screen center, or needs padding, or region specified),
                    # show thumbnail because the image doesn't show the complete screen
                    
                    if show_thumbnail:
                        try:
                            # Load fullscreen screenshot for thumbnail
                            fullscreen_img = Image.open(BytesIO(fullscreen_bytes))
                            
                            # Calculate thumbnail size (about 20% of image width, maintain aspect ratio)
                            thumbnail_max_width = int(new_width * 0.2)
                            thumbnail_max_height = int(new_height * 0.2)
                            
                            # Calculate thumbnail size maintaining aspect ratio
                            thumb_scale = min(thumbnail_max_width / screen_width, thumbnail_max_height / screen_height)
                            thumb_width = int(screen_width * thumb_scale)
                            thumb_height = int(screen_height * thumb_scale)
                            
                            # Create thumbnail
                            thumbnail = fullscreen_img.resize((thumb_width, thumb_height), Image.Resampling.LANCZOS)
                            
                            # Calculate zoom region bounds in fullscreen coordinates
                            if zoom_factor is not None:
                                # Use the same calculation as in the zoom_factor block above
                                # Calculate the zoom region bounds based on center and desired size
                                zoom_region_x = center_x - desired_capture_width // 2
                                zoom_region_y = center_y - desired_capture_height // 2
                                zoom_region_x_end = zoom_region_x + desired_capture_width
                                zoom_region_y_end = zoom_region_y + desired_capture_height
                            elif region is not None:
                                # Legacy region mode - use region bounds directly
                                zoom_region_x = region['x']
                                zoom_region_y = region['y']
                                zoom_region_x_end = zoom_region_x + region['width']
                                zoom_region_y_end = zoom_region_y + region['height']
                            else:
                                # Fallback: use capture region
                                zoom_region_x = offset_x
                                zoom_region_y = offset_y
                                zoom_region_x_end = offset_x + capture_width
                                zoom_region_y_end = offset_y + capture_height
                            
                            # Clamp to screen bounds for display
                            zoom_region_x_clamped = max(0, min(zoom_region_x, screen_width))
                            zoom_region_y_clamped = max(0, min(zoom_region_y, screen_height))
                            zoom_region_x_end_clamped = max(0, min(zoom_region_x_end, screen_width))
                            zoom_region_y_end_clamped = max(0, min(zoom_region_y_end, screen_height))
                            
                            # Convert to thumbnail coordinates
                            thumb_region_x = int(zoom_region_x_clamped * thumb_scale)
                            thumb_region_y = int(zoom_region_y_clamped * thumb_scale)
                            thumb_region_x_end = int(zoom_region_x_end_clamped * thumb_scale)
                            thumb_region_y_end = int(zoom_region_y_end_clamped * thumb_scale)
                            
                            # Draw green rectangle on thumbnail to show zoom region
                            thumb_draw = ImageDraw.Draw(thumbnail)
                            thumb_draw.rectangle(
                                [thumb_region_x, thumb_region_y, thumb_region_x_end, thumb_region_y_end],
                                outline=(0, 255, 0, 255),  # Green color
                                width=2
                            )
                            
                            # Position thumbnail in bottom-right corner with some margin
                            margin = 10
                            thumb_x = new_width - thumb_width - margin
                            thumb_y = new_height - thumb_height - margin
                            
                            # Paste thumbnail onto main image
                            # Convert thumbnail to RGB if needed (for pasting onto RGB image)
                            if thumbnail.mode != 'RGB':
                                thumbnail = thumbnail.convert('RGB')
                            new_img.paste(thumbnail, (thumb_x, thumb_y))
                            
                            # Draw border around thumbnail
                            draw.rectangle(
                                [thumb_x - 1, thumb_y - 1, thumb_x + thumb_width + 1, thumb_y + thumb_height + 1],
                                outline=(0, 0, 0, 255),  # Black border
                                width=1
                            )
                            
                            print(f"[DesktopTools] Added thumbnail: {thumb_width}x{thumb_height} at ({thumb_x}, {thumb_y})")
                            print(f"[DesktopTools] Zoom region in thumbnail: ({thumb_region_x}, {thumb_region_y}) to ({thumb_region_x_end}, {thumb_region_y_end})")
                            
                        except Exception as e:
                            # If thumbnail fails, continue without it
                            import traceback
                            print(f"[DesktopTools] Failed to add thumbnail: {e}")
                            traceback.print_exc()
                    
                    # Save to bytes
                    output = BytesIO()
                    img.save(output, format='PNG')
                    screenshot_bytes = output.getvalue()
                    
                    # Update dimensions for return value
                    width = new_width
                    height = new_height
                    
                    print(f"[DesktopTools] Saved grid overlay with padding, new size: {len(screenshot_bytes)} bytes (original: {original_size} bytes)")
                    
                except Exception as e:
                    # If grid overlay fails, use original screenshot
                    import traceback
                    print(f"[DesktopTools] Failed to add grid overlay: {e}")
                    traceback.print_exc()
            
            os.unlink(temp_path)
            
            # Build result with clear usage hint
            result = {
                "success": True,
                "screenshot": base64.b64encode(screenshot_bytes).decode('utf-8'),
                "width": width,
                "height": height,
            }
            
            # Add coordinate info for mouse operations
            if zoom_factor is not None and 'center_x' in dir():
                # Zoomed screenshot - show visible range
                vis_x_start = offset_x
                vis_y_start = offset_y
                vis_x_end = offset_x + capture_width
                vis_y_end = offset_y + capture_height
                result["visible_region"] = {
                    "x_start": vis_x_start,
                    "y_start": vis_y_start,
                    "x_end": vis_x_end,
                    "y_end": vis_y_end
                }
                result["center"] = {"x": center_x, "y": center_y}
                
                # Zoomed view hint (used internally by mouse aim action)
                result["hint"] = f"""ZOOMED VIEW at ({center_x}, {center_y}), zoom={zoom_factor}x.
Visible: x={vis_x_start}~{vis_x_end}, y={vis_y_start}~{vis_y_end}"""
            elif region:
                # Region screenshot
                result["visible_region"] = {
                    "x_start": offset_x,
                    "y_start": offset_y,
                    "x_end": offset_x + capture_width,
                    "y_end": offset_y + capture_height
                }
                result["hint"] = f"""REGION VIEW ({offset_x}-{offset_x+capture_width}, {offset_y}-{offset_y+capture_height}).

⚠️ To click, use mouse(action='aim', x=TARGET_X, y=TARGET_Y) first."""
            else:
                # Full screen
                result["screen_size"] = {"width": screen_width, "height": screen_height}
                result["hint"] = f"""FULL SCREEN ({screen_width}x{screen_height}).

⚠️ TO CLICK:
1. Estimate target coordinates (X, Y) from the grid
2. mouse(action='aim', x=X, y=Y) to aim and verify
3. Follow the recommendation in aim result"""
            
            # Add scale info if image was resized
            if HAS_PIL and width > 0 and height > 0 and scale != 1.0:
                result["original_width"] = original_width
                result["original_height"] = original_height
                result["scale"] = scale
                if 'original_grid_spacing' in locals():
                    result["grid_spacing"] = original_grid_spacing
            
            return result
            
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    @staticmethod
    async def mouse(
        action: Literal["aim", "click", "double", "right_click", "down", "move", "up", "scroll"],
        # For aim action - absolute positioning
        x: Optional[int] = None,
        y: Optional[int] = None,
        zoom: float = 2.0,
        # For aim action - delta adjustment (relative to previous aim)
        delta_x: Optional[int] = None,
        delta_y: Optional[int] = None,
        # For execute actions (click, double, right_click, down, move, scroll)
        aim_id: Optional[str] = None,
        # For scroll action
        direction: Optional[Literal["up", "down", "left", "right"]] = None,
        amount: int = 3
    ) -> Dict[str, Any]:
        """
        Two-phase mouse control: aim first, then execute.
        
        Actions:
            aim: Aim at position (absolute x,y or delta from previous aim)
            click/double/right_click: Click at aim_id position
            down/move/up: Drag operations
            scroll: Scroll at aim_id position
        
        Aim modes:
            Absolute: mouse(action='aim', x=600, y=400, zoom=2)
            Delta: mouse(action='aim', aim_id='...', delta_x=-50, delta_y=20, zoom=4)
        """
        global _mouse_state
        
        try:
            # ========== AIM ACTION ==========
            if action == "aim":
                # Track previous position for delta visualization
                prev_center_for_screenshot = None
                
                # Determine target position
                if delta_x is not None or delta_y is not None:
                    # Delta mode: adjust from previous aim position
                    if not aim_id:
                        return {"success": False, "error": "delta adjustment requires aim_id from previous aim"}
                    
                    prev_aim = _aim_cache.get(aim_id)
                    if not prev_aim:
                        return {"success": False, "error": f"Invalid or expired aim_id: {aim_id}"}
                    
                    # Save previous position for arrow visualization
                    prev_center_for_screenshot = {"x": prev_aim["x"], "y": prev_aim["y"]}
                    
                    # Calculate new position
                    x = prev_aim["x"] + (delta_x or 0)
                    y = prev_aim["y"] + (delta_y or 0)
                    
                elif x is not None and y is not None:
                    # Absolute mode: use provided coordinates
                    pass
                else:
                    return {"success": False, "error": "aim requires either (x, y) or (aim_id with delta_x/delta_y)"}
                
                # Create new aim_id
                new_aim_id = _aim_cache.create(x, y, zoom)
                
                # Take zoomed screenshot centered at (x, y)
                screenshot_result = await DesktopTools.screenshot(
                    center={"x": x, "y": y},
                    zoom_factor=zoom,
                    grid_density="normal",
                    prev_center=prev_center_for_screenshot
                )
                
                if not screenshot_result.get("success"):
                    return screenshot_result
                
                # Get grid spacing info for hint
                grid_spacing = screenshot_result.get("grid_spacing", 100)
                
                # Build hint based on crosshair coordinate axes
                hint = f"""aim: ({x}, {y}) | zoom: {zoom}x | grid: {grid_spacing}px | aim_id: {new_aim_id}

Crosshair is at origin (0). Read target position from grid → that's your delta.

Tips:
- Target close (delta < 50)? Increase zoom first (6-10) for finer grid
- Keep delta smaller than grid spacing to avoid overshooting

Adjust: mouse(action='aim', aim_id='{new_aim_id}', delta_x=?, delta_y=?, zoom=...)
Click:  mouse(action='click', aim_id='{new_aim_id}')"""
                
                return {
                    "success": True,
                    "aim_id": new_aim_id,
                    "position": {"x": x, "y": y},
                    "zoom": zoom,
                    "grid_spacing": grid_spacing,
                    "screenshot": screenshot_result.get("screenshot"),
                    "width": screenshot_result.get("width"),
                    "height": screenshot_result.get("height"),
                    "hint": hint
                }
            
            # ========== EXECUTE ACTIONS (require aim_id) ==========
            
            # Check if action requires aim_id
            actions_requiring_aim_id = ["click", "double", "right_click", "down", "move", "scroll"]
            
            if action in actions_requiring_aim_id:
                if not aim_id:
                    return {
                        "success": False, 
                        "error": f"'{action}' requires aim_id. Use mouse(action='aim', x=..., y=...) first."
                    }
                
                # Get position from aim_id
                aim_data = _aim_cache.get(aim_id)
                if not aim_data:
                    return {
                        "success": False,
                        "error": f"Invalid or expired aim_id: {aim_id}. Please aim again."
                    }
                
                pos_x = aim_data["x"]
                pos_y = aim_data["y"]
            
            btn_map = {"left": "1", "middle": "2", "right": "3"}
            
            # ========== CLICK ==========
            if action == "click":
                cmd = ["xdotool", "mousemove", str(pos_x), str(pos_y), "click", "1"]
                result = subprocess.run(cmd, capture_output=True, text=True)
                
                if result.returncode != 0:
                    return {"success": False, "error": f"Click failed: {result.stderr}"}
                
                return {
                    "success": True,
                    "action": "click",
                    "position": {"x": pos_x, "y": pos_y},
                    "hint": f"Clicked at ({pos_x}, {pos_y}). Use screenshot() to verify result."
                }
            
            # ========== DOUBLE CLICK ==========
            elif action == "double":
                cmd = ["xdotool", "mousemove", str(pos_x), str(pos_y), 
                       "click", "--repeat", "2", "--delay", "100", "1"]
                result = subprocess.run(cmd, capture_output=True, text=True)
                
                if result.returncode != 0:
                    return {"success": False, "error": f"Double click failed: {result.stderr}"}
                
                return {
                    "success": True,
                    "action": "double_click",
                    "position": {"x": pos_x, "y": pos_y},
                    "hint": f"Double-clicked at ({pos_x}, {pos_y}). Use screenshot() to verify result."
                }
            
            # ========== RIGHT CLICK ==========
            elif action == "right_click":
                cmd = ["xdotool", "mousemove", str(pos_x), str(pos_y), "click", "3"]
                result = subprocess.run(cmd, capture_output=True, text=True)
                
                if result.returncode != 0:
                    return {"success": False, "error": f"Right click failed: {result.stderr}"}
                
                return {
                    "success": True,
                    "action": "right_click",
                    "position": {"x": pos_x, "y": pos_y},
                    "hint": f"Right-clicked at ({pos_x}, {pos_y}). Use screenshot() to verify result."
                }
            
            # ========== DOWN (for drag start) ==========
            elif action == "down":
                if _mouse_state["is_down"]:
                    return {
                        "success": False,
                        "error": "Mouse already held down. Call mouse(action='up') first."
                    }
                
                # Don't consume aim_id for down, allow re-use for debugging
                cmd = ["xdotool", "mousemove", str(pos_x), str(pos_y), "mousedown", "1"]
                result = subprocess.run(cmd, capture_output=True, text=True)
                
                if result.returncode != 0:
                    return {"success": False, "error": f"Mouse down failed: {result.stderr}"}
                
                _mouse_state["is_down"] = True
                _mouse_state["position"] = {"x": pos_x, "y": pos_y}
                
                return {
                    "success": True,
                    "action": "down",
                    "position": {"x": pos_x, "y": pos_y},
                    "hint": f"Mouse down at ({pos_x}, {pos_y}). Now aim for destination, then mouse(action='move', aim_id=...) and mouse(action='up')."
                }
            
            # ========== MOVE (while button pressed) ==========
            elif action == "move":
                # Move doesn't consume aim_id
                cmd = ["xdotool", "mousemove", str(pos_x), str(pos_y)]
                result = subprocess.run(cmd, capture_output=True, text=True)
                
                if result.returncode != 0:
                    return {"success": False, "error": f"Mouse move failed: {result.stderr}"}
                
                _mouse_state["position"] = {"x": pos_x, "y": pos_y}
                
                hint = f"Moved to ({pos_x}, {pos_y})."
                if _mouse_state["is_down"]:
                    hint += " Mouse still held. Call mouse(action='up') to release."
                
                return {
                    "success": True,
                    "action": "move",
                    "position": {"x": pos_x, "y": pos_y},
                    "is_down": _mouse_state["is_down"],
                    "hint": hint
                }
            
            # ========== UP (release) ==========
            elif action == "up":
                if not _mouse_state["is_down"]:
                    return {
                        "success": False,
                        "error": "Mouse not held down. Nothing to release."
                    }
                
                cmd = ["xdotool", "mouseup", "1"]
                result = subprocess.run(cmd, capture_output=True, text=True)
                
                if result.returncode != 0:
                    return {"success": False, "error": f"Mouse up failed: {result.stderr}"}
                
                released_pos = _mouse_state["position"]
                _mouse_state["is_down"] = False
                _mouse_state["position"] = None
                
                return {
                    "success": True,
                    "action": "up",
                    "released_at": released_pos,
                    "hint": f"Mouse released at ({released_pos['x']}, {released_pos['y']}). Drag complete."
                }
            
            # ========== SCROLL ==========
            elif action == "scroll":
                if direction is None:
                    return {"success": False, "error": "scroll requires direction (up/down/left/right)"}
                
                # Move to position first
                subprocess.run(["xdotool", "mousemove", str(pos_x), str(pos_y)])
                
                # Scroll buttons: 4=up, 5=down, 6=left, 7=right
                scroll_btn = {"up": "4", "down": "5", "left": "6", "right": "7"}[direction]
                cmd = ["xdotool", "click", "--repeat", str(amount), scroll_btn]
                result = subprocess.run(cmd, capture_output=True, text=True)
                
                if result.returncode != 0:
                    return {"success": False, "error": f"Scroll failed: {result.stderr}"}
                
                return {
                    "success": True,
                    "action": "scroll",
                    "position": {"x": pos_x, "y": pos_y},
                    "direction": direction,
                    "amount": amount,
                    "hint": f"Scrolled {direction} {amount} times at ({pos_x}, {pos_y})."
                }
            
            else:
                return {"success": False, "error": f"Unknown action: {action}"}
            
        except Exception as e:
            import traceback
            traceback.print_exc()
            return {"success": False, "error": str(e)}
    
    @staticmethod
    async def keyboard(
        action: Literal["type", "key"],
        text: Optional[str] = None,
        keys: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """
        Control keyboard using xdotool
        
        Args:
            action: type (input text) or key (press keys)
            text: Text to type (for type action)
            keys: Keys to press (for key action), e.g., ['ctrl', 'c']
        """
        try:
            if action == "type":
                if not text:
                    return {"success": False, "error": "type requires text"}
                
                # Handle newlines: split text by \n and type each part with Enter between
                if "\n" in text:
                    import time
                    lines = text.split("\n")
                    for i, line in enumerate(lines):
                        if line:  # Only type non-empty lines
                            has_non_ascii = any(ord(c) > 127 for c in line)
                            if has_non_ascii:
                                # Type character by character for Chinese text
                                for char in line:
                                    char_cmd = ["xdotool", "type", "--clearmodifiers", char]
                                    char_result = subprocess.run(char_cmd, capture_output=True, text=True, timeout=10)
                                    if char_result.returncode != 0:
                                        return {"success": False, "error": f"xdotool failed: {char_result.stderr}"}
                                    time.sleep(0.2)  # 200ms delay for input method
                            else:
                                cmd = ["xdotool", "type", "--clearmodifiers", line]
                                result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
                                if result.returncode != 0:
                                    return {"success": False, "error": result.stderr}
                        
                        # Press Enter after each line except the last
                        if i < len(lines) - 1:
                            subprocess.run(["xdotool", "key", "Return"], capture_output=True, timeout=5)
                            time.sleep(0.05)  # Small delay for reliability
                    
                    return {"success": True, "typed": text, "lines": len(lines)}
                
                # No newlines - simple case
                # Check if text contains non-ASCII characters (Chinese, etc.)
                has_non_ascii = any(ord(c) > 127 for c in text)
                
                if has_non_ascii:
                    # For non-ASCII text (Chinese, etc.), type character by character
                    # xdotool + ibus/fcitx needs more time to process each Unicode character
                    # Using per-character input with 200ms delay to avoid character duplication
                    import time
                    for char in text:
                        char_cmd = ["xdotool", "type", "--clearmodifiers", char]
                        char_result = subprocess.run(char_cmd, capture_output=True, text=True, timeout=10)
                        if char_result.returncode != 0:
                            return {"success": False, "error": f"xdotool failed on char: {char_result.stderr}"}
                        time.sleep(0.2)  # 200ms delay between characters for input method
                    
                    return {"success": True, "typed": text, "method": "char_by_char"}
                else:
                    # For ASCII-only text, use faster input
                    cmd = ["xdotool", "type", "--clearmodifiers", text]
                
            elif action == "key":
                if not keys:
                    return {"success": False, "error": "key requires keys array"}
                
                # Key name mapping
                key_map = {
                    "ctrl": "ctrl", "alt": "alt", "shift": "shift",
                    "super": "super", "win": "super", "meta": "super",
                    "enter": "Return", "return": "Return",
                    "tab": "Tab", "escape": "Escape", "esc": "Escape",
                    "backspace": "BackSpace", "delete": "Delete",
                    "space": "space",
                    "up": "Up", "down": "Down", "left": "Left", "right": "Right",
                    "home": "Home", "end": "End",
                    "pageup": "Page_Up", "page_up": "Page_Up",
                    "pagedown": "Page_Down", "page_down": "Page_Down",
                    "f1": "F1", "f2": "F2", "f3": "F3", "f4": "F4",
                    "f5": "F5", "f6": "F6", "f7": "F7", "f8": "F8",
                    "f9": "F9", "f10": "F10", "f11": "F11", "f12": "F12",
                }
                
                mapped_keys = [key_map.get(k.lower(), k) for k in keys]
                combo = "+".join(mapped_keys)
                cmd = ["xdotool", "key", combo]
            else:
                return {"success": False, "error": f"Unknown action: {action}"}
            
            result = subprocess.run(cmd, capture_output=True, text=True)
            
            if result.returncode != 0:
                return {"success": False, "error": f"xdotool failed: {result.stderr}"}
            
            return {"success": True}
            
        except Exception as e:
            return {"success": False, "error": str(e)}

